import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createServer } from "vite";

const run = promisify(execFile);
async function findChromium() {
  const candidates = [
    process.env.CHROMIUM,
    "chromium-browser",
    "chromium",
    "google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const paths = candidate.includes("/")
      ? [candidate]
      : (process.env.PATH ?? "").split(":").map((entry) => resolve(entry, candidate));
    for (const path of paths) {
      try {
        await access(path, constants.X_OK);
        return path;
      } catch {}
    }
  }
  throw new Error("Chromium not found. Set CHROMIUM to the browser executable path.");
}
const here = import.meta.dirname;
const output = resolve(here, "../../docs/public/screenshots");
const temp = await mkdtemp(resolve(tmpdir(), "appflare-shots-"));
const server = await createServer({ configFile: resolve(here, "vite.config.ts") });
await server.listen();
const chrome = spawn(
  await findChromium(),
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=0",
    `--user-data-dir=${resolve(temp, "chrome")}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function waitForPort() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const [port] = (await readFile(resolve(temp, "chrome/DevToolsActivePort"), "utf8")).split(
        "\n",
      );
      return Number(port);
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  throw new Error("Chromium did not open its debugging port");
}

class ChromePage {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  close() {
    this.socket.close();
  }
}

async function openPage(port, width, height) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const target = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveSocket, reject) => {
    socket.addEventListener("open", resolveSocket, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const page = new ChromePage(socket);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: width < 600,
  });
  await page.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  return page;
}

async function settle(page, expected) {
  for (let attempt = 0; attempt < 450; attempt++) {
    const ready = await page.evaluate(`(() => {
      const heading = document.querySelector('h1');
      return heading && document.body?.innerText.includes(${JSON.stringify(expected)}) &&
        [...document.images].filter((image) => {
          const box = image.getBoundingClientRect();
          return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
        }).every((image) => image.complete && image.naturalWidth > 0);
    })()`);
    if (ready) {
      await page.evaluate(
        "document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))",
      );
      return;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Page did not settle: ${expected}`);
}

async function scrollTo(page, text) {
  const found = await page.evaluate(`(() => {
    const heading = [...document.querySelectorAll('h2,h3')].find((item) => item.textContent.trim() === ${JSON.stringify(text)});
    if (!heading) return false;
    let parent = heading.parentElement;
    while (parent && parent !== document.body) {
      if (parent.scrollHeight > parent.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
        const spacer = document.createElement('div');
        spacer.style.height = '900px';
        parent.append(spacer);
        heading.scrollIntoView({block:'start'});
        parent.scrollTop -= 25;
        break;
      }
      parent = parent.parentElement;
    }
    return true;
  })()`);
  if (!found) throw new Error(`Heading missing: ${text}`);
  await new Promise((done) => setTimeout(done, 250));
}

async function click(page, label) {
  const found = await page.evaluate(`(() => {
    const item = [...document.querySelectorAll('button,a')].find((element) => element.textContent.trim() === ${JSON.stringify(label)});
    if (!item) return false;
    item.click();
    return true;
  })()`);
  if (!found) throw new Error(`Control missing: ${label}`);
  await new Promise((done) => setTimeout(done, 350));
}

/** Types into the inputs of a form, by their `name`, the way React notices. */
async function fill(page, values) {
  const missing = await page.evaluate(`(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const [name, value] of Object.entries(${JSON.stringify(values)})) {
      const input = document.querySelector('input[name="' + name + '"]');
      if (!input) return name;
      setValue.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return null;
  })()`);
  if (missing) throw new Error(`Input missing: ${missing}`);
}

/** Picks the choice (a radio card) whose label starts with `label`. */
async function choose(page, label) {
  const found = await page.evaluate(`(() => {
    const item = [...document.querySelectorAll('label')].find((element) => element.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!item) return false;
    item.click();
    return true;
  })()`);
  if (!found) throw new Error(`Choice missing: ${label}`);
  await new Promise((done) => setTimeout(done, 350));
}

/**
 * Replaces text on the page, for words the harness cannot give the page
 * itself: the address it runs at is localhost, not the manager's own.
 */
async function replaceText(page, from, to) {
  const count = await page.evaluate(`(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let count = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.nodeValue.includes(${JSON.stringify(from)})) continue;
      node.nodeValue = node.nodeValue.replaceAll(${JSON.stringify(from)}, ${JSON.stringify(to)});
      count++;
    }
    return count;
  })()`);
  if (count === 0) throw new Error(`Text missing: ${from}`);
}

const shots = [
  {
    name: "home-dashboard",
    path: "/",
    expected: "Needs attention",
    cropBottomSelector: "#your-apps",
  },
  {
    name: "catalog-storefront",
    path: "/catalog",
    expected: "New this week",
    viewportWidth: 1680,
    expandCarousel: "New this week",
    cropWidth: 1360,
    height: 520,
  },
  { name: "catalog-app", path: "/catalog/emdash", expected: "EmDash", height: 790 },
  {
    name: "catalog-needs",
    path: "/catalog/emdash",
    expected: "What it needs on your account",
    scroll: "What it needs on your account",
    cropBottomSelector: "#installed",
  },
  {
    name: "install-app-settings",
    path: "/catalog/cloudmark#install",
    expected: "Install Cloudmark",
    blur: true,
    wait: 600,
    viewportHeight: 1600,
    resetScroll: true,
    cropBottomSelector: "#install",
  },
  {
    name: "install-access",
    path: "/catalog/cloudmark#install",
    expected: "Install Cloudmark",
    blur: true,
    wait: 600,
    viewportHeight: 1600,
    resetScroll: true,
    cropSelector: "#install-access",
  },
  {
    name: "apps-access",
    path: "/apps/install-cut?tab=domains",
    expected: "Cloudflare Access",
    scroll: "Cloudflare Access",
    cropSelector: "#access",
  },
  {
    name: "apps-installed-overview",
    path: "/apps/install-cut",
    expected: "Short links",
    height: 690,
  },
  {
    name: "apps-installed-settings",
    path: "/apps/install-cut?tab=settings",
    expected: "Settings and secrets",
    height: 720,
  },
  {
    name: "updates-needs-attention",
    path: "/",
    expected: "Needs attention",
    cropSelector: "#needs-attention",
  },
  {
    name: "updates-review",
    path: "/apps/install-statusbeam",
    expected: "Update available",
    click: "Update",
    cropBottomSelector: '[role="dialog"]',
  },
  {
    name: "settings-account-capabilities",
    path: "/settings/account",
    expected: "What this account can run",
    viewportHeight: 1600,
    cropBottomSelector: "#capabilities",
  },
  {
    name: "domains-external-list",
    path: "/settings/domains",
    expected: "External domains",
    cropBottomSelector: "#external-domains",
  },
  {
    name: "address-workers-dev",
    path: "/settings/domains",
    expected: "Appflare lives at its workers.dev address.",
    cropSelector: "#address",
  },
  {
    name: "address-dialog",
    path: "/settings/domains",
    expected: "Appflare lives at its workers.dev address.",
    prepare: async (page) => {
      await click(page, "Use a domain");
      await settle(page, "Move Appflare");
    },
    wait: 600,
    cropSelector: '[role="dialog"]',
    // The page behind the dialog is dimmed but readable; no margin keeps its words out.
    cropMargin: 0,
  },
  {
    name: "address-on-domain",
    path: "/settings/domains?fixture=address-on-domain",
    expected: "sends page visits here.",
    cropSelector: "#address",
  },
  {
    // Setup from the owner step on: the owner is created (the fixtures
    // stand in for the server), then the address step, with a domain chosen.
    name: "setup-address-step",
    path: "/setup",
    expected: "Create the owner account",
    viewportHeight: 1100,
    prepare: async (page) => {
      await fill(page, {
        name: "Ada Lovelace",
        email: "ada@example.com",
        password: "correct horse battery staple",
      });
      await click(page, "Create owner account");
      await settle(page, "Where should Appflare live?");
      await choose(page, "Use a domain of yours");
      await replaceText(page, "localhost:5388", "appflare.example.workers.dev");
    },
    wait: 400,
    cropSelector: "main > div > :last-child",
  },
  {
    name: "domains-custom-form",
    path: "/apps/install-cut?tab=domains",
    expected: "Custom domains",
    click: "Add a domain",
    height: 700,
  },
  {
    name: "users-list",
    path: "/settings/users",
    expected: "Ada Lovelace",
    cropBottomSelector: "#forgotten-passwords",
  },
  {
    name: "users-passkeys",
    path: "/settings/users",
    expected: "Your passkeys",
    scroll: "Your passkeys",
    cropBottomSelector: "#access",
  },
  {
    name: "notifications-channel",
    path: "/settings/notifications",
    expected: "Team updates",
    cropBottomSelector: "#channels",
  },
  { name: "building-sandbox", path: "/settings/building", expected: "Sandbox Worker", height: 335 },
  {
    name: "jobs-install-log",
    path: "/jobs/01K5Q3MGN7F6YP8T2RC9VJ4BXA",
    expected: "Health check passed",
    cropBottomSelector: "main section:last-of-type",
  },
  {
    name: "settings-appflare-updates",
    path: "/settings/updates",
    expected: "Appflare version",
    height: 850,
  },
  {
    // The front page of the site: the whole viewport, the sidebar with the
    // logo and the list of apps included.
    name: "landing-home",
    path: "/",
    expected: "Needs attention",
    sidebar: true,
    height: 900,
  },
  {
    name: "catalog-phone",
    path: "/catalog?q=statusbeam",
    expected: "Catalog",
    width: 390,
    viewportHeight: 800,
    height: 770,
  },
];

try {
  await mkdir(output, { recursive: true });
  const port = await waitForPort();
  for (const shot of shots) {
    if (process.env.SHOT && shot.name !== process.env.SHOT) continue;
    const width = shot.width ?? shot.viewportWidth ?? 1440;
    const page = await openPage(port, width, shot.viewportHeight ?? 900);
    try {
      await page.send("Page.navigate", { url: `http://localhost:5388${shot.path}` });
      await settle(page, shot.expected);
      if (shot.blur)
        await page.evaluate(
          "document.activeElement?.blur(); history.replaceState(null, '', location.pathname)",
        );
      if (shot.scroll) await scrollTo(page, shot.scroll);
      if (shot.click) await click(page, shot.click);
      if (shot.prepare) await shot.prepare(page);
      if (shot.resetScroll) {
        await page.evaluate("document.querySelector('main')?.scrollTo(0, 0)");
        await new Promise((done) => setTimeout(done, 350));
      }
      if (shot.expandCarousel) {
        const expanded = await page.evaluate(`(() => {
          const row = [...document.querySelectorAll('section')].find((section) =>
            section.querySelector('h2')?.textContent.trim() === ${JSON.stringify(shot.expandCarousel)});
          const list = row?.querySelector('ul');
          if (!list) return false;
          list.style.overflowX = 'visible';
          return true;
        })()`);
        if (!expanded) throw new Error(`${shot.name}: carousel missing`);
      }
      await page.evaluate(`new Promise(done => setTimeout(done, ${shot.wait ?? 250}))`);
      const fixtureError = await page.evaluate(
        "document.body.innerText.match(/Missing screenshot fixture: [A-Za-z0-9_]+/)?.[0] ?? null",
      );
      if (fixtureError) throw new Error(`${shot.name}: ${fixtureError}`);
      const wholeWidth = Boolean(shot.width || shot.sidebar);
      let crop = {
        left: wholeWidth ? 0 : 264,
        top: 0,
        width: shot.cropWidth ?? (wholeWidth ? width : width - 264),
        height: shot.height,
      };
      if (shot.cropSelector) {
        const box = await page.evaluate(`(() => {
          const element = document.querySelector(${JSON.stringify(shot.cropSelector)});
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        })()`);
        if (!box) throw new Error(`${shot.name}: crop element missing`);
        const margin = shot.cropMargin ?? 16;
        const left = Math.max(0, Math.floor(box.left - margin));
        const top = Math.max(0, Math.floor(box.top - margin));
        crop = {
          left,
          top,
          width: Math.min(width, Math.ceil(box.right + margin)) - left,
          height: Math.min(shot.viewportHeight ?? 900, Math.ceil(box.bottom + margin)) - top,
        };
      }
      if (shot.cropBottomSelector) {
        const bottom = await page.evaluate(`(() => {
          const element = document.querySelector(${JSON.stringify(shot.cropBottomSelector)});
          return element?.getBoundingClientRect().bottom ?? null;
        })()`);
        if (bottom === null || bottom > (shot.viewportHeight ?? 900) - 16)
          throw new Error(`${shot.name}: whole install card does not fit in viewport`);
        crop.height = Math.ceil(bottom + 16);
      }
      const { data } = await page.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const raw = resolve(temp, `${shot.name}.png`);
      await writeFile(raw, Buffer.from(data, "base64"));
      const target = resolve(output, `${shot.name}.png`);
      await run("magick", [
        raw,
        "-crop",
        `${crop.width * 2}x${crop.height * 2}+${crop.left * 2}+${crop.top * 2}`,
        "+repage",
        "-strip",
        target,
      ]);
      console.log(`${shot.name}.png`);
    } finally {
      page.close();
    }
  }
} finally {
  chrome.kill();
  if (chrome.exitCode === null) await new Promise((done) => chrome.once("exit", done));
  await server.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
}
