from __future__ import annotations

import base64
import binascii
import os
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator


ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "app" / "static"
DATA_DIR = Path(os.environ.get("FUTURE_RECORD_DATA_DIR", str(ROOT_DIR / "data"))).expanduser()
IMAGES_DIR = DATA_DIR / "images"
DB_PATH = DATA_DIR / "future_records.sqlite"

DATA_URL_RE = re.compile(r"^data:image/png;base64,(?P<data>.+)$", re.DOTALL)

ACCOUNTS = {
    "huaan": "华安期货",
    "shengda": "盛达期货",
}
DEFAULT_ACCOUNT = "huaan"


app = FastAPI(title="Future Record", version="0.1.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class RecordCreate(BaseModel):
    trade_date: str = Field(..., description="Trading date in YYYY-MM-DD format")
    note: str = Field(default="", max_length=1000)
    image_base64: str = Field(..., description="PNG data URL")

    @field_validator("trade_date")
    @classmethod
    def validate_trade_date(cls, value: str) -> str:
        return validate_date(value)


class RecordUpdate(BaseModel):
    trade_date: str | None = None
    note: str | None = Field(default=None, max_length=1000)
    sequence_no: int | None = Field(default=None, ge=1)

    @field_validator("trade_date")
    @classmethod
    def validate_optional_trade_date(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return validate_date(value)


def validate_date(value: str) -> str:
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError("trade_date must use YYYY-MM-DD") from exc
    return value


def validate_account(account: str) -> str:
    if account not in ACCOUNTS:
        raise HTTPException(status_code=404, detail="Account not found")
    return account


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def ensure_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account TEXT NOT NULL DEFAULT 'huaan',
                trade_date TEXT NOT NULL,
                sequence_no INTEGER NOT NULL,
                image_path TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            )
            """
        )
        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(records)").fetchall()
        }
        if "account" not in columns:
            conn.execute(
                "ALTER TABLE records ADD COLUMN account TEXT NOT NULL DEFAULT 'huaan'"
            )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_records_order
            ON records (account, trade_date, sequence_no, created_at)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_records_deleted
            ON records (deleted_at)
            """
        )


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def decode_png_data_url(image_base64: str) -> bytes:
    match = DATA_URL_RE.match(image_base64)
    if not match:
        raise HTTPException(
            status_code=400,
            detail="image_base64 must be a PNG data URL",
        )

    try:
        image_bytes = base64.b64decode(match.group("data"), validate=True)
    except binascii.Error as exc:
        raise HTTPException(status_code=400, detail="Invalid base64 image data") from exc

    if not image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(status_code=400, detail="Uploaded image is not a PNG")

    return image_bytes


def record_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    image_path = row["image_path"]
    account = row["account"]
    return {
        "id": row["id"],
        "account": account,
        "account_name": ACCOUNTS.get(account, account),
        "trade_date": row["trade_date"],
        "sequence_no": row["sequence_no"],
        "image_path": image_path,
        "image_url": f"/images/{image_path}",
        "note": row["note"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "deleted_at": row["deleted_at"],
    }


def next_sequence(conn: sqlite3.Connection, account: str, trade_date: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(sequence_no), 0) AS max_seq
        FROM records
        WHERE account = ? AND trade_date = ?
        """,
        (account, trade_date),
    ).fetchone()
    return int(row["max_seq"]) + 1


def build_image_path(account: str, trade_date: str, sequence_no: int) -> tuple[Path, str]:
    year, month, _ = trade_date.split("-")
    relative_dir = Path(account) / year / month
    relative_path = relative_dir / f"{trade_date}_{sequence_no:04d}.png"
    return IMAGES_DIR / relative_path, relative_path.as_posix()


@app.on_event("startup")
def startup() -> None:
    ensure_storage()


@app.get("/")
def root() -> RedirectResponse:
    return RedirectResponse(f"/{DEFAULT_ACCOUNT}")


@app.get("/api/accounts")
def list_accounts() -> list[dict[str, str]]:
    return [{"slug": slug, "name": name} for slug, name in ACCOUNTS.items()]


@app.get("/{account}")
def index(account: str) -> FileResponse:
    validate_account(account)
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/accounts/{account}/records", status_code=201)
def create_record(account: str, payload: RecordCreate) -> dict[str, Any]:
    ensure_storage()
    account = validate_account(account)
    image_bytes = decode_png_data_url(payload.image_base64)
    created_at = now_iso()

    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        sequence_no = next_sequence(conn, account, payload.trade_date)
        image_file, relative_path = build_image_path(account, payload.trade_date, sequence_no)

        while image_file.exists():
            sequence_no += 1
            image_file, relative_path = build_image_path(account, payload.trade_date, sequence_no)

        image_file.parent.mkdir(parents=True, exist_ok=True)
        image_file.write_bytes(image_bytes)

        cursor = conn.execute(
            """
            INSERT INTO records (
                account, trade_date, sequence_no, image_path, note, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                account,
                payload.trade_date,
                sequence_no,
                relative_path,
                payload.note.strip(),
                created_at,
                created_at,
            ),
        )
        record = conn.execute(
            "SELECT * FROM records WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()

    return record_to_dict(record)


@app.get("/api/accounts/{account}/records")
def list_records(
    account: str,
    trade_date: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    include_deleted: bool = False,
) -> list[dict[str, Any]]:
    ensure_storage()
    account = validate_account(account)
    params: list[Any] = [account]
    clauses: list[str] = ["account = ?"]

    if trade_date:
        validate_date(trade_date)
        clauses.append("trade_date = ?")
        params.append(trade_date)

    if not include_deleted:
        clauses.append("deleted_at IS NULL")

    where_clause = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = f"""
        SELECT *
        FROM records
        {where_clause}
        ORDER BY trade_date ASC, sequence_no ASC, created_at ASC
    """

    with connect() as conn:
        rows = conn.execute(sql, params).fetchall()

    return [record_to_dict(row) for row in rows]


@app.get("/api/accounts/{account}/dates")
def list_dates(account: str, include_deleted: bool = False) -> list[dict[str, Any]]:
    ensure_storage()
    account = validate_account(account)
    clauses = ["account = ?"]
    if not include_deleted:
        clauses.append("deleted_at IS NULL")
    where_clause = f"WHERE {' AND '.join(clauses)}"
    sql = f"""
        SELECT trade_date, COUNT(*) AS count
        FROM records
        {where_clause}
        GROUP BY trade_date
        ORDER BY trade_date DESC
    """

    with connect() as conn:
        rows = conn.execute(sql, (account,)).fetchall()

    return [{"trade_date": row["trade_date"], "count": row["count"]} for row in rows]


@app.patch("/api/accounts/{account}/records/{record_id}")
def update_record(account: str, record_id: int, payload: RecordUpdate) -> dict[str, Any]:
    ensure_storage()
    account = validate_account(account)
    updates: list[str] = []
    params: list[Any] = []

    if payload.trade_date is not None:
        updates.append("trade_date = ?")
        params.append(payload.trade_date)
    if payload.note is not None:
        updates.append("note = ?")
        params.append(payload.note.strip())
    if payload.sequence_no is not None:
        updates.append("sequence_no = ?")
        params.append(payload.sequence_no)

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates.append("updated_at = ?")
    params.append(now_iso())
    params.append(account)
    params.append(record_id)

    with connect() as conn:
        existing = conn.execute(
            "SELECT id FROM records WHERE account = ? AND id = ? AND deleted_at IS NULL",
            (account, record_id),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Record not found")

        conn.execute(
            f"UPDATE records SET {', '.join(updates)} WHERE account = ? AND id = ?",
            params,
        )
        record = conn.execute("SELECT * FROM records WHERE id = ?", (record_id,)).fetchone()

    return record_to_dict(record)


@app.delete("/api/accounts/{account}/records/{record_id}")
def delete_record(account: str, record_id: int) -> dict[str, Any]:
    ensure_storage()
    account = validate_account(account)
    deleted_at = now_iso()

    with connect() as conn:
        existing = conn.execute(
            "SELECT id FROM records WHERE account = ? AND id = ? AND deleted_at IS NULL",
            (account, record_id),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Record not found")

        conn.execute(
            "UPDATE records SET deleted_at = ?, updated_at = ? WHERE account = ? AND id = ?",
            (deleted_at, deleted_at, account, record_id),
        )

    return {"ok": True, "deleted_at": deleted_at}


@app.get("/images/{image_path:path}")
def get_image(image_path: str) -> FileResponse:
    ensure_storage()
    image_file = (IMAGES_DIR / image_path).resolve()
    images_root = IMAGES_DIR.resolve()

    if images_root not in image_file.parents and image_file != images_root:
        raise HTTPException(status_code=404, detail="Image not found")
    if not image_file.is_file():
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(image_file)
