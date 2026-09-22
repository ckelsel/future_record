const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createElement() {
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    dataset: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
    addEventListener() {},
    append() {},
    close() {},
    focus() {},
    removeAttribute() {},
    select() {},
    setAttribute() {},
    showModal() {},
  };
}

function loadApp() {
  const elements = new Map();
  const fetchCalls = [];
  const timeouts = [];
  const document = {
    documentElement: { dataset: { theme: "dark" } },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, createElement());
      return elements.get(selector);
    },
    querySelectorAll() {
      return [];
    },
    createElement,
    addEventListener() {},
  };
  const context = vm.createContext({
    console,
    document,
    localStorage: { getItem() {}, setItem() {} },
    fetch: async (url) => {
      fetchCalls.push(url);
      return {
        ok: true,
        async json() {
          return [];
        },
      };
    },
    window: {
      location: { pathname: "/huaan" },
      setInterval() {},
      clearInterval() {},
      setTimeout(callback, delay) {
        timeouts.push({ callback, delay });
        return timeouts.length;
      },
      clearTimeout() {},
    },
  });

  const appPath = path.join(__dirname, "..", "app", "static", "app.js");
  const source = fs.readFileSync(appPath, "utf8").replace(
    /\ninit\(\)\.catch\([\s\S]*?\n\}\);\s*$/,
    "",
  );
  vm.runInContext(
    `${source}\nglobalThis.testApi = { millisecondsUntilDailyRefresh, startDailyRefreshTimer, state, els };`,
    context,
  );

  return { api: context.testApi, fetchCalls, timeouts };
}

test("daily refresh timer fires once at 15:00 and switches to today", async () => {
  const { api, fetchCalls, timeouts } = loadApp();
  const now = new Date(2026, 8, 23, 14, 59);

  api.startDailyRefreshTimer(now);
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].delay, 60 * 1000);

  await timeouts[0].callback();
  assert.equal(api.els.tradeDate.value, todayForTest());
  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[1], new RegExp(`trade_date=${todayForTest()}$`));
  assert.equal(timeouts.length, 2);
});

function todayForTest() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
