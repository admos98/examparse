/** Optional real-Chromium smoke test. No project dependencies or paid network calls.
 * Build first, then: EXAMPARSE_BROWSER_MODULES=/path/to/tools/node_modules node --import tsx test/browser.smoke.mjs
 * External tools: playwright-core + @sparticuz/chromium (or CHROMIUM_PATH) + @fontsource/noto-naskh-arabic.
 * Everything is isolated in a temporary folder and a temporary server; existing user data is never selected.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { brotliDecompressSync } from "node:zlib";
import { DEFAULT_SETTINGS } from "../src/store/index.ts";
import { assembleAndValidateQuestions } from "../src/pipeline/assemble.ts";
import { examContentRevision } from "../src/pipeline/quality.ts";
const require = createRequire(
  process.env.EXAMPARSE_BROWSER_MODULES
    ? path.join(process.env.EXAMPARSE_BROWSER_MODULES, "../browser-runner.cjs")
    : import.meta.url,
);
const { chromium: playwright } = require("playwright-core");
const bundled = process.env.CHROMIUM_PATH
  ? undefined
  : require("@sparticuz/chromium").default;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "examparse-browser-"));
let browser;
let child;
let upstream;
let count = 0;
function check(value, message) {
  assert.ok(value, message);
  console.log(`PASS ${++count}: ${message}`);
}
async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
try {
  // The sandbox lacks NSS; use only the libraries shipped with the optional Chromium package.
  if (bundled) {
    const entry = require.resolve("@sparticuz/chromium");
    const archive = path.resolve(path.dirname(entry), "../bin/al2023.tar.br");
    const tar = path.join(root, "libs.tar");
    await fs.writeFile(tar, brotliDecompressSync(await fs.readFile(archive)));
    execFileSync("tar", ["-xf", tar, "-C", root]);
    process.env.LD_LIBRARY_PATH = [
      path.join(root, "lib"),
      process.env.LD_LIBRARY_PATH,
    ]
      .filter(Boolean)
      .join(":");
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      GEMINI_API_KEY: "",
      EXAMFORGE_DATA_DIR: "",
      EXAMPARSE_CONFIG_FILE: path.join(root, "config.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let logs = "";
    const timeout = setTimeout(
      () => reject(new Error(`Server timeout: ${logs}`)),
      15000,
    );
    child.stdout.on("data", (chunk) => {
      logs += chunk;
      if (logs.includes("ExamParse server running")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      logs += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exit ${code}: ${logs}`));
    });
  });
  const api = async (url, method = "GET", body) => {
    const response = await fetch(base + url, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok)
      throw new Error(
        `${method} ${url}: ${response.status} ${await response.text()}`,
      );
    return response.json();
  };
  browser = await playwright.launch({
    executablePath:
      process.env.CHROMIUM_PATH || (await bundled.executablePath()),
    args: (bundled?.args || ["--no-sandbox"]).filter(
      (a) =>
        !a.startsWith("--disable-web-security") &&
        !a.startsWith("--allow-running-insecure-content"),
    ),
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  let llmRequests = 0;
  page.on("pageerror", (e) => errors.push(String(e)));
  // Refuse any remote browser traffic: no CDNs, fonts or providers needed for this test.
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (
      (url.protocol === "http:" && url.origin === base) ||
      ["data:", "blob:", "about:"].includes(url.protocol)
    )
      return route.continue();
    return route.abort();
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/llm") llmRequests++;
  });
  const fontFile = path.join(
    path.dirname(require.resolve("@fontsource/noto-naskh-arabic/package.json")),
    "files/noto-naskh-arabic-arabic-400-normal.woff2",
  );
  const font = (await fs.readFile(fontFile)).toString("base64");
  await page.setContent(
    `<style>@font-face{font-family:Arabic;src:url(data:font/woff2;base64,${font})}*{box-sizing:border-box}body{margin:0;font:16px Arial,Arabic}.paper{position:relative;width:800px;height:1000px;break-after:page}.header{position:absolute;top:20px;left:50px}.footer{position:absolute;top:950px;left:50px}.col{position:absolute;top:110px;width:300px;line-height:30px}.left{left:45px}.right{left:450px}.photo{position:absolute;top:500px;width:100px;height:100px}</style>${Array.from({ length: 6 }, (_, p) => `<div class="paper"><div class="header">National Exam — Row | Questions | Points</div><div class="col left">${2 * p + 1}. Original question ${2 * p + 1}<br>مي‌شود؟ يكي ديگر<br>Choose the best answer.<br>a) Original option one<br>b) Original option two<br>Keep the source unchanged.</div><div class="col right">${2 * p + 2}. Original question ${2 * p + 2}<br>Read this English passage.<br>Answer without changing text.<br>a) Another original option<br>b) The alternative option<br>End of the second column.</div><div class="footer">National Examination Board — Page ${p + 1}</div></div>`).join("")}`,
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let i = 0; i < 8; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = 100;
      canvas.height = i < 6 ? 10 : 100;
      const c = canvas.getContext("2d");
      const gradient = c.createLinearGradient(0, 0, 100, canvas.height);
      gradient.addColorStop(0, `hsl(${i * 40},80%,40%)`);
      gradient.addColorStop(1, "#eeeeff");
      c.fillStyle = gradient;
      c.fillRect(0, 0, 100, canvas.height);
      c.fillStyle = "black";
      c.fillRect(15, 3, 20, 3);
      const image = document.createElement("img");
      image.src = canvas.toDataURL();
      image.style.cssText = `position:absolute;left:${i < 6 ? 50 : 250 + (i - 6) * 200}px;top:${i < 6 ? 500 + i * 10 : 500}px;width:100px;height:${canvas.height}px`;
      document.querySelector(".paper").append(image);
      await image.decode();
    }
  });
  const pdf = await page.pdf({
    width: "800px",
    height: "1000px",
    margin: { top: 0, bottom: 0, left: 0, right: 0 },
    printBackground: true,
  });
  check(
    pdf.length > 1000,
    "generated a genuine six-page, two-column PDF with Persian font and eight embedded images",
  );
  await page.goto(base);
  await page
    .getByRole("heading", {
      name: "ExamParse stores everything in a local folder.",
    })
    .waitFor();
  check(
    (await api("/api/storage/health")).configured === false,
    "first launch blocks the pipeline until a folder is selected",
  );
  page.once("dialog", (dialog) => dialog.accept(path.join(root, "folder")));
  await page
    .getByRole("button", { name: "Choose folder", exact: true })
    .click();
  await page.locator("input[type=file]").first().waitFor({ state: "attached" });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "browser-real.pdf",
      mimeType: "application/pdf",
      buffer: pdf,
    });
  await page
    .getByRole("button", { name: "Assistant", exact: true })
    .waitFor({ state: "visible", timeout: 30000 });
  await page.waitForFunction(
    () => !document.querySelector("nav button[aria-pressed]")?.disabled,
    { timeout: 30000 },
  );
  const summaries = await api("/api/exams");
  const draftSummary = summaries.find(
    (s) => s.fileName === "browser-real.pdf" || s.pages === 6,
  );
  assert.ok(draftSummary, JSON.stringify(summaries));
  const draft = await api(`/api/exams/${draftSummary.id}`);
  check(
    draft.source.pages === 6 &&
      draft.source.lines.length >= 40 &&
      draft.questions.length === 0,
    `real PDF import persisted ${draft.source.pages} pages / ${draft.source.lines.length} line-addressed source lines, provider-free`,
  );
  check(
    draft.source.expectedQuestionNos.length === 12,
    `two-column expected set contains all 12 printed questions (${draft.source.expectedQuestionNos})`,
  );
  check(
    draft.source.lines.some((l) => /[\p{Script=Arabic}]/u.test(l.text)),
    "real PDF.js extracts Arabic-script source alongside English",
  );
  check(
    draft.source.lines.filter((l) => l.furniture).length >= 6,
    `repeated page furniture tagged without dropping addresses (${draft.source.lines.filter((l) => l.furniture).length} lines)`,
  );
  check(
    draft.source.pageThumbKeys.length === 6 &&
      (await fetch(base + `/api/images/${draft.source.pageThumbKeys[0]}`)).ok,
    "six real rendered page thumbnails persist and load from the folder",
  );
  check(
    draft.source.lines
      .filter((l) => l.text.includes("Original option"))
      .every((l) => !l.furniture),
    "repeated body options are not misclassified as page furniture",
  );
  const merged = draft.images.find((i) => i.bbox.x < 100);
  const mergedBytes = await (
    await fetch(base + `/api/images/${merged.blobKey}`)
  ).arrayBuffer();
  check(
    createHash("sha256").update(Buffer.from(mergedBytes)).digest("hex") ===
      merged.sha &&
      merged.dHash.length === 16 &&
      merged.width === merged.bbox.w &&
      merged.height === merged.bbox.h,
    "real merged crop bytes, SHA-256, dimensions and dHash are materialized and persisted consistently",
  );
  check(
    draft.images.length === 3 && draft.source.diagnostics.imagesMerged === 5,
    `real PDF six strips + two photos merge and persist as exactly three assets (${draft.images.length} assets, ${draft.source.diagnostics.imagesMerged} merged)`,
  );
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const assistant = page.getByRole("region", { name: "Exam assistant" });
  await assistant.waitFor();
  check(
    (await page.locator('[data-assistant-mode="page"]').count()) === 1 &&
      (await page.getByRole("button", { name: /2\. Source/ }).count()) === 0,
    "Assistant navigation opens a dedicated page, not a drawer or hidden duplicate pipeline",
  );
  await page
    .getByRole("button", { name: "Check this exam end-to-end", exact: true })
    .click();
  await page
    .getByText("Configure a model to chat.", { exact: false })
    .waitFor();
  check(
    llmRequests === 0 && draft.usage.length === 0,
    "source-only health check completes through actual UI with zero provider requests",
  );
  await page.getByRole("button", { name: "Back to exam", exact: true }).click();
  check(
    (await page.getByRole("button", { name: /2\. Source/ }).count()) === 1,
    "returning from Assistant preserves the current pipeline step",
  );

  // A fully parsed two-section fixture for real UI → harness → local mock proxy → structure → confirmation/CAS/Undo.
  const source = [
    { id: "L0001", page: 1, text: "Writing" },
    { id: "L0002", page: 1, text: "1. Keep this exact original stem" },
    { id: "L0003", page: 1, text: "2. Keep another exact original stem" },
    { id: "L0004", page: 1, text: "Reading" },
    { id: "L0005", page: 1, text: "3. Outside section must remain unchanged" },
  ];
  const exam = {
    id: "browser_parsed",
    fileHash: "browser_fixture",
    createdAt: new Date().toISOString(),
    displayName: "Browser parsed fixture",
    meta: { language: "en", direction: "ltr", totalPoints: 3 },
    source: {
      lines: source,
      pages: 1,
      fileName: "parsed.txt",
      ocrUsed: false,
      expectedQuestionNos: [1, 2, 3],
    },
    questions: assembleAndValidateQuestions(
      [
        {
          id: "q1",
          no: 1,
          sectionId: "s1",
          spans: [[2, 2]],
          points: 1,
          type: "short",
          confidence: 0.9,
        },
        {
          id: "q2",
          no: 2,
          sectionId: "s1",
          spans: [[3, 3]],
          points: 1,
          type: "short",
          confidence: 0.9,
        },
        {
          id: "q3",
          no: 3,
          sectionId: "s2",
          spans: [[5, 5]],
          points: 1,
          type: "short",
          confidence: 0.9,
        },
      ],
      source,
    ).questions,
    sections: [
      { id: "s1", index: 1, title: "Writing", spans: [[1, 3]] },
      { id: "s2", index: 2, title: "Reading", spans: [[4, 5]] },
    ],
    images: [],
    flags: [],
    usage: [],
  };
  await api(`/api/exams/${exam.id}`, "PUT", exam);
  let mode = "reparse";
  let modeCalls = 0;
  let upstreamCalls = 0;
  const call = (name, args) =>
    `\`\`\`tool\n${JSON.stringify({ name, args })}\n\`\`\``;
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    upstreamCalls++;
    const isChat = body.messages[0].content.includes(
      "ExamParse's careful assistant",
    );
    let content;
    if (!isChat)
      content = JSON.stringify({
        q: [
          { n: 1, p: 2, t: "s", v: 0.75, c: 9 },
          { n: 2, p: 3, t: "s", v: 1.25, c: 9 },
        ],
        s: [{ id: "s1", p: [1, 3], kind: "Writing" }],
        m: { totalPoints: 2 },
      });
    else if (++modeCalls > 1)
      content = "Please use the measured local verification result.";
    else
      content =
        mode === "theme"
          ? call("set_theme_token", { token: "primary", value: "#EAB308" })
          : mode === "language"
            ? call("set_language", { language: "fa" })
            : mode === "refuse"
              ? call("delete_everything", {})
              : call("reparse_section", { sectionId: "s1" });
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 40 } })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 40, completion_tokens: 40 },
        }),
      );
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.uiLanguage = "en";
  settings.providers = [
    ...settings.providers,
    {
      id: "browser_mock",
      name: "Local offline mock",
      kind: "openai-compatible",
      baseURL: `http://127.0.0.1:${upstream.address().port}/v1`,
      apiKey: "",
      disableReasoning: true,
      structuredOutputs: false,
      extraBodyJson: "",
    },
  ];
  settings.costTable["offline-test"] = {
    inputCostPerMillion: 10,
    outputCostPerMillion: 20,
  };
  settings.roleMapping.fast = {
    providerId: "browser_mock",
    model: "offline-test",
  };
  settings.roleMapping.agent = {
    providerId: "browser_mock",
    model: "offline-test",
  };
  await page.evaluate(
    (s) => localStorage.setItem("examparse_settings_v1", JSON.stringify(s)),
    settings,
  );
  await page.reload();
  async function openParsed() {
    await page.getByRole("button", { name: "Library", exact: true }).click();
    const card = page
      .locator("div.rounded-2xl")
      .filter({
        has: page.getByText("Browser parsed fixture", { exact: true }),
      });
    await card.getByRole("button", { name: "Open", exact: true }).click();
  }
  await openParsed();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const message = page.getByRole("textbox", { name: "Message assistant" });
  await message.fill("Reparse Writing section only");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm", exact: true })
    .waitFor({ timeout: 30000 });
  const pending = await api("/api/journals/agent_session_browser_parsed");
  check(
    pending.prepared &&
      pending.pending.name === "reparse_section" &&
      (await api("/api/exams/browser_parsed")).questions[0].points === 1,
    "real structure adapter prepares a durable candidate without changing exam content",
  );
  check(
    (await page
      .getByText("Exact section diff — all fields, before / after", {
        exact: true,
      })
      .count()) === 1 &&
      (await page.locator("pre").allTextContents()).some((t) =>
        t.includes("0.75"),
      ),
    "confirmation renders the complete before/after candidate, not a prediction",
  );
  await page.reload();
  await openParsed();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).waitFor();
  check(
    upstreamCalls === 2,
    "reload restores pending consent without repeating model or structure calls",
  );
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByText("Verified green:", { exact: false }).waitFor();
  const applied = await api("/api/exams/browser_parsed");
  check(
    applied.questions[0].points === 0.75 &&
      applied.questions[1].points === 1.25 &&
      JSON.stringify(applied.questions[2]) ===
        JSON.stringify(exam.questions[2]),
    "explicit consent commits exact candidate via CAS; other section is unchanged",
  );
  const completed = await api("/api/journals/agent_session_browser_parsed");
  check(
    completed.costUsd > pending.costUsd &&
      completed.calls === 3 &&
      Math.abs(
        completed.costUsd -
          applied.usage.reduce((n, u) => n + (u.costUsd || 0), 0),
      ) < 1e-9,
    "resume preserves cumulative preparation cost and includes all three calls in session telemetry",
  );
  check(
    applied.usage.length === 3 && upstreamCalls === 3,
    "all three actual local upstream calls (including preparation) are audited",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).last().click();
  await page.getByText("Restored pre-action state.", { exact: true }).waitFor();
  check(
    examContentRevision(await api("/api/exams/browser_parsed")) ===
      examContentRevision(exam),
    "browser Undo restores exact content including flags, while retaining usage audit",
  );
  mode = "theme";
  modeCalls = 0;
  await message.fill("Make the blue yellow");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.documentElement.style.getPropertyValue("--app-primary") ===
      "#EAB308",
  );
  await page
    .getByRole("button", { name: "Back to exam", exact: true })
    .waitFor({ state: "visible" });
  check(
    (await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("examparse_settings_v1")).themeTokens
          .primary,
    )) === "#EAB308",
    "real Assistant changes and persists the allowlisted theme token",
  );
  // Wait for the final observation before starting another turn.
  await page.waitForFunction(
    () =>
      !document.querySelector('input[aria-label="Message assistant"]')
        ?.disabled,
  );
  mode = "language";
  modeCalls = 0;
  await message.fill("زبان رابط را فارسی کن");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("textbox", { name: "پیام به دستیار" }).waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector('input[aria-label="پیام به دستیار"]')?.disabled,
  );
  check(
    (await page.locator('[data-assistant-mode="page"][dir="rtl"]').count()) ===
      1,
    "Assistant switches to Persian RTL page with localized controls and statuses",
  );
  mode = "refuse";
  modeCalls = 0;
  await page
    .getByRole("textbox", { name: "پیام به دستیار" })
    .fill("همه چیز را حذف کن");
  await page.getByRole("button", { name: "ارسال", exact: true }).click();
  await page
    .getByText("ابزار غیرمجاز یا ناشناخته:", { exact: false })
    .waitFor();
  check(
    (await api("/api/exams/browser_parsed")).questions.length === 3,
    "forbidden action is refused in Persian without mutation",
  );
  await page.waitForFunction(
    () =>
      !document.querySelector('input[aria-label="پیام به دستیار"]')?.disabled,
  );
  await page
    .getByRole("button", { name: "بازگشت به آزمون", exact: true })
    .click();
  mode = "verify";
  modeCalls = 1;
  await page
    .getByRole("button", {
      name: "از دستیار بخواهید استخراج را بررسی کند",
      exact: true,
    })
    .click();
  await page.locator('[data-assistant-mode="panel"]').waitFor();
  check(
    (await page.locator("[data-assistant-mode]").count()) === 1 &&
      (await page.getByRole("button", { name: /4\. Review/ }).count()) === 1,
    "Step 4 contextual verification uses one panel instance while review stays accessible",
  );
  await page.waitForFunction(
    () =>
      !document.querySelector('input[aria-label="پیام به دستیار"]')?.disabled,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    (await page
      .locator('[data-assistant-mode="panel"]')
      .evaluate((el) => el.getBoundingClientRect().width)) <= 390,
    "context panel fits a 390px mobile viewport",
  );
  await page.getByRole("button", { name: "بستن", exact: true }).click();
  await page
    .getByRole("button", { name: "Settings & Provider Config", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Storage & Privacy", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reset theme / بازنشانی رنگ‌ها", exact: true })
    .click();
  check(
    await page.evaluate(
      () =>
        !JSON.parse(localStorage.getItem("examparse_settings_v1")).themeTokens
          .primary &&
        document.documentElement.style.getPropertyValue("--app-primary") !==
          "#EAB308",
    ),
    "actual Settings reset restores default theme without touching exams",
  );
  check(
    errors.length === 0,
    `no uncaught browser errors (${errors.join("; ")})`,
  );
  console.log(
    `BROWSER SMOKE: ${count} checks passed; only a local mock provider was used (${upstreamCalls} upstream requests).`,
  );
} finally {
  await browser?.close();
  child?.kill("SIGTERM");
  if (child && child.exitCode === null) await once(child, "exit");
  if (upstream) await new Promise((r) => upstream.close(r));
  await fs.rm(root, { recursive: true, force: true });
}
