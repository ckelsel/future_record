# Future Record

Local web app for saving and reviewing daily trading screenshots.

## Environment

Use the named Conda environment requested for this project:

```bash
conda activate future-record
pip install -r requirements.txt
```

## Run

```bash
conda activate future-record
./r.sh
```

The app binds to `0.0.0.0:8787` by default, so the current machine and other devices on the same LAN can access it.

Local access:

```text
http://127.0.0.1:8787/huaan
http://127.0.0.1:8787/shengda
```

LAN access:

```text
http://YOUR_LAN_IP:8787/huaan
http://YOUR_LAN_IP:8787/shengda
```

Accounts:

- `huaan`: 华安期货
- `shengda`: 盛达期货

Find the LAN IP on Linux with:

```bash
hostname -I
```

If another device cannot connect, allow TCP port `8787` through the local firewall.

## Use

1. Open the URL for the account you want to record.
2. Choose the trading date.
3. Press `Ctrl+V` to paste a screenshot from the clipboard.
4. Add an optional note.
5. Click save.
6. Browse saved screenshots by date and delete wrong entries when needed.

After 15:00, if the current account has no screenshot saved for today, the open page shows a reminder dialog and plays three short beeps. The reminder is per account and per day.

Screenshots and the SQLite database are stored under `data/`. Deleting a record is a soft delete: the row is hidden by default, but the database keeps the deletion timestamp.

Set `FUTURE_RECORD_DATA_DIR=/some/path` before running if you want to store data somewhere else.
