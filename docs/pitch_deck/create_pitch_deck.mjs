import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const runtimeRoot = "/Users/opinderpreetsingh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node";
const require = createRequire(path.join(runtimeRoot, "package.json"));
const artifactPath = require.resolve("@oai/artifact-tool");
const artifactRequire = createRequire(artifactPath);
const {
  Presentation,
  PresentationFile,
  column,
  row,
  grid,
  panel,
  text,
  rule,
  fill,
  fixed,
  hug,
  wrap,
  fr,
  auto,
  drawSlideToCtx,
} = await import(artifactPath);
const { Canvas } = artifactRequire("skia-canvas");

const outDir = path.resolve("docs/pitch_deck");
const previewDir = path.join(outDir, "previews");
fs.mkdirSync(previewDir, { recursive: true });

const W = 1920;
const H = 1080;
const colors = {
  ink: "#08111F",
  navy: "#101B2E",
  slate: "#334155",
  cloud: "#EAF2F8",
  mist: "#B8C7D9",
  teal: "#0F9F8F",
  cyan: "#3CC7D9",
  amber: "#F4B942",
  red: "#E45858",
  white: "#FFFFFF",
};

const titleStyle = { fontSize: 64, bold: true, color: colors.white, typeface: "Aptos Display" };
const darkTitleStyle = { fontSize: 60, bold: true, color: colors.ink, typeface: "Aptos Display" };
const bodyStyle = { fontSize: 30, color: colors.mist, typeface: "Aptos" };
const darkBodyStyle = { fontSize: 28, color: colors.slate, typeface: "Aptos" };
const labelStyle = { fontSize: 22, bold: true, color: colors.teal, typeface: "Aptos" };

const presentation = Presentation.create({
  slideSize: { width: W, height: H },
});

function addSlide(bg = colors.ink) {
  const slide = presentation.slides.add();
  slide.compose(
    panel(
      {
        name: "slide-bg",
        width: fill,
        height: fill,
        padding: { x: 84, y: 70 },
        fill: bg,
      },
      column({ name: "root", width: fill, height: fill, gap: 34 }, []),
    ),
    { frame: { left: 0, top: 0, width: W, height: H }, baseUnit: 8 },
  );
  return slide;
}

function compose(slide, child, bg = colors.ink) {
  slide.compose(
    panel(
      {
        name: "slide-bg",
        width: fill,
        height: fill,
        padding: { x: 84, y: 70 },
        fill: bg,
      },
      child,
    ),
    { frame: { left: 0, top: 0, width: W, height: H }, baseUnit: 8 },
  );
}

function footer(textValue, color = "#7890A6") {
  return text(textValue, {
    name: "footer",
    width: fill,
    height: hug,
    style: { fontSize: 16, color, typeface: "Aptos" },
  });
}

function pill(label, fillColor = "#112A3A") {
  return panel(
    {
      name: `pill-${label}`,
      width: fill,
      height: hug,
      padding: { x: 24, y: 16 },
      borderRadius: "rounded-full",
      fill: fillColor,
    },
    text(label, {
      name: `pill-text-${label}`,
      width: fill,
      height: hug,
      style: { fontSize: 24, bold: true, color: colors.white, typeface: "Aptos" },
    }),
  );
}

function bullets(items, style = bodyStyle) {
  return column(
    { name: "bullets", width: fill, height: hug, gap: 18 },
    items.map((item, i) =>
      text(`• ${item}`, {
        name: `bullet-${i + 1}`,
        width: fill,
        height: hug,
        style,
      }),
    ),
  );
}

// 1. Cover
{
  const slide = addSlide();
  compose(
    slide,
    grid(
      {
        name: "cover-grid",
        width: fill,
        height: fill,
        columns: [fr(1.15), fr(0.85)],
        rows: [fr(1), auto],
        columnGap: 72,
      },
      [
        column(
          { name: "cover-copy", width: fill, height: fill, gap: 28 },
          [
            text("ShieldLend", {
              name: "cover-title",
              width: fill,
              height: hug,
              style: { fontSize: 118, bold: true, color: colors.white, typeface: "Aptos Display" },
            }),
            rule({ name: "cover-rule", width: fixed(260), stroke: colors.teal, weight: 8 }),
            text("Private lending on Solana without turning credit history into public surveillance.", {
              name: "cover-subtitle",
              width: wrap(980),
              height: hug,
              style: { fontSize: 40, color: colors.cloud, typeface: "Aptos" },
            }),
          ],
        ),
        column(
          { name: "cover-stack", width: fill, height: fill, gap: 18 },
          [
            pill("ZK note ownership"),
            pill("Private repay settlement", "#0B6E69"),
            pill("Encrypted oracle health", "#174A63"),
            pill("Stealth exits", "#2B3A67"),
          ],
        ),
        footer("Colosseum Frontier Hackathon 2026", colors.mist),
      ],
    ),
  );
}

// 2. Problem
{
  const slide = addSlide(colors.white);
  compose(
    slide,
    column(
      { name: "problem", width: fill, height: fill, gap: 34 },
      [
        text("DeFi lending is transparent in the wrong places", {
          name: "title",
          width: wrap(1250),
          height: hug,
          style: darkTitleStyle,
        }),
        grid(
          { name: "problem-grid", width: fill, height: fill, columns: [fr(1), fr(1)], columnGap: 54 },
          [
            bullets(
              [
                "depositor wallet and timing",
                "borrower wallet and loan size",
                "repayment event and amount",
                "withdrawal destination",
              ],
              darkBodyStyle,
            ),
            text("The result is a permanent public credit profile. That is not acceptable for institutions, treasuries, payroll users, or privacy-sensitive individuals.", {
              name: "problem-claim",
              width: fill,
              height: hug,
              style: { fontSize: 42, bold: true, color: colors.ink, typeface: "Aptos Display" },
            }),
          ],
        ),
        footer("Problem framing", "#64748B"),
      ],
    ),
    colors.white,
  );
}

// 3. Why single tools fail
{
  const slide = addSlide();
  compose(
    slide,
    column(
      { name: "single-tools", width: fill, height: fill, gap: 30 },
      [
        text("One privacy primitive is not enough", { name: "title", width: fill, height: hug, style: titleStyle }),
        grid(
          { name: "tool-grid", width: fill, height: fill, columns: [fr(1), fr(1), fr(1), fr(1)], columnGap: 22 },
          [
            pill("Mixers\nno lending state", "#14334B"),
            pill("Stealth addresses\nhide destination only", "#154C47"),
            pill("ZK proofs\ndo not hide public transfers", "#4A2D16"),
            pill("FHE\nnot address privacy", "#34245D"),
          ],
        ),
        text("ShieldLend composes execution privacy, ZK ownership, private payments, encrypted oracle state, and stealth exits into one lending workflow.", {
          name: "claim",
          width: wrap(1420),
          height: hug,
          style: { fontSize: 38, color: colors.cloud, typeface: "Aptos" },
        }),
        footer("Architecture thesis"),
      ],
    ),
  );
}

// 4. Stack
{
  const slide = addSlide(colors.white);
  const rows = [
    ["IKA dWallet", "Relay authorization; no single operator key"],
    ["MagicBlock PER", "Deposit and exit timing unlinkability"],
    ["Groth16 circuits", "Note ownership and collateral checks"],
    ["MagicBlock Private Payments", "Repayment settlement privacy"],
    ["Encrypt FHE", "Encrypted oracle and health computation"],
    ["Umbra", "One-time output addresses and disclosure hygiene"],
  ];
  compose(
    slide,
    column(
      { name: "stack", width: fill, height: fill, gap: 24 },
      [
        text("A privacy stack with distinct jobs", { name: "title", width: fill, height: hug, style: darkTitleStyle }),
        column(
          { name: "stack-rows", width: fill, height: fill, gap: 14 },
          rows.map(([name, role], i) =>
            row(
              { name: `stack-row-${i}`, width: fill, height: hug, gap: 24 },
              [
                text(name, { name: `name-${i}`, width: fixed(460), height: hug, style: { ...labelStyle, fontSize: 28 } }),
                text(role, { name: `role-${i}`, width: fill, height: hug, style: darkBodyStyle }),
              ],
            ),
          ),
        ),
        footer("Each sponsor protocol has a separate technical reason", "#64748B"),
      ],
    ),
    colors.white,
  );
}

// 5. User flow
{
  const slide = addSlide();
  compose(
    slide,
    column(
      { name: "flow", width: fill, height: fill, gap: 30 },
      [
        text("The user journey stays simple", { name: "title", width: fill, height: hug, style: titleStyle }),
        row(
          { name: "flow-row", width: fill, height: hug, gap: 16 },
          ["Deposit", "Borrow", "Receive", "Repay", "Unlock", "Disclose"].map((step, i) =>
            panel(
              { name: `step-${i}`, width: fill, height: fixed(160), padding: { x: 18, y: 22 }, fill: i === 3 ? "#0B6E69" : "#14233A" },
              text(step, { name: `step-text-${i}`, width: fill, height: hug, style: { fontSize: 30, bold: true, color: colors.white, typeface: "Aptos Display" } }),
            ),
          ),
        ),
        text("Behind each step, the protocol changes which public observer can link what. The product should feel like lending; the architecture absorbs the privacy complexity.", {
          name: "flow-claim",
          width: wrap(1350),
          height: hug,
          style: { fontSize: 38, color: colors.cloud, typeface: "Aptos" },
        }),
        footer("MVP product story"),
      ],
    ),
  );
}

// 6. Safety
{
  const slide = addSlide(colors.white);
  compose(
    slide,
    column(
      { name: "safety", width: fill, height: fill, gap: 30 },
      [
        text("The lending mechanics stay conservative", { name: "title", width: fill, height: hug, style: darkTitleStyle }),
        grid(
          { name: "safety-grid", width: fill, height: fill, columns: [fr(1), fr(1)], columnGap: 56 },
          [
            bullets(
              [
                "public or bucketed borrow amount for deterministic LTV",
                "Kamino-style interest model",
                "full liquidation only for MVP",
                "minimum position size and reserve accounting",
              ],
              darkBodyStyle,
            ),
            text("Privacy wraps the credit workflow. It does not replace solvency, liquidation, or bad-debt controls.", {
              name: "safety-claim",
              width: fill,
              height: hug,
              style: { fontSize: 44, bold: true, color: colors.ink, typeface: "Aptos Display" },
            }),
          ],
        ),
        footer("DeFi risk posture", "#64748B"),
      ],
    ),
    colors.white,
  );
}

// 7. Precise claims
{
  const slide = addSlide();
  compose(
    slide,
    column(
      { name: "claims", width: fill, height: fill, gap: 28 },
      [
        text("Privacy claims, without overclaiming", { name: "title", width: fill, height: hug, style: titleStyle }),
        grid(
          { name: "claims-grid", width: fill, height: fill, columns: [fr(1), fr(1)], columnGap: 58 },
          [
            column(
              { name: "hidden", width: fill, height: hug, gap: 18 },
              [
                text("Hidden", { name: "hidden-label", width: fill, height: hug, style: { ...labelStyle, color: colors.cyan } }),
                bullets(["depositor to commitment", "borrower to loan", "collateral note identity", "repayment graph in Full Privacy mode", "output wallet identity"]),
              ],
            ),
            column(
              { name: "visible", width: fill, height: hug, gap: 18 },
              [
                text("Visible by design", { name: "visible-label", width: fill, height: hug, style: { ...labelStyle, color: colors.amber } }),
                bullets(["loan exists", "borrow amount or bucket", "aggregate protocol state", "fallback mode warnings"]),
              ],
            ),
          ],
        ),
        footer("Credible privacy is specific"),
      ],
    ),
  );
}

// 8. Competitive positioning
{
  const slide = addSlide(colors.white);
  compose(
    slide,
    column(
      { name: "competitive", width: fill, height: fill, gap: 24 },
      [
        text("Positioned as private lending infrastructure", { name: "title", width: fill, height: hug, style: darkTitleStyle }),
        grid(
          { name: "comp-grid", width: fill, height: fill, columns: [fr(0.8), fr(1.2)], rows: [auto, auto, auto, auto], columnGap: 34, rowGap: 20 },
          [
            text("General privacy pools", { width: fill, height: hug, style: { ...labelStyle, color: colors.teal } }),
            text("No lending state machine", { width: fill, height: hug, style: darkBodyStyle }),
            text("Stealth address tools", { width: fill, height: hug, style: { ...labelStyle, color: colors.teal } }),
            text("Hide destinations only", { width: fill, height: hug, style: darkBodyStyle }),
            text("FHE lending prototypes", { width: fill, height: hug, style: { ...labelStyle, color: colors.teal } }),
            text("Do not solve address and exit privacy alone", { width: fill, height: hug, style: darkBodyStyle }),
            text("ShieldLend", { width: fill, height: hug, style: { ...labelStyle, color: colors.ink } }),
            text("Full lifecycle privacy around a conservative lending core", { width: fill, height: hug, style: { ...darkBodyStyle, bold: true, color: colors.ink } }),
          ],
        ),
        footer("Competitive narrative", "#64748B"),
      ],
    ),
    colors.white,
  );
}

// 9. Demo
{
  const slide = addSlide();
  compose(
    slide,
    column(
      { name: "demo", width: fill, height: fill, gap: 26 },
      [
        text("Demo arc", { name: "title", width: fill, height: hug, style: titleStyle }),
        bullets([
          "deposit into shielded pool and save local note",
          "borrow against hidden collateral note",
          "receive disbursement at Umbra stealth address",
          "repay with private payment receipt",
          "unlock collateral and export selected history",
        ]),
        text("The judge should see both privacy and lending correctness in one continuous flow.", {
          name: "demo-claim",
          width: wrap(1320),
          height: hug,
          style: { fontSize: 42, bold: true, color: colors.white, typeface: "Aptos Display" },
        }),
        footer("Hackathon demo plan"),
      ],
    ),
  );
}

// 10. Roadmap / ask
{
  const slide = addSlide(colors.white);
  compose(
    slide,
    column(
      { name: "ask", width: fill, height: fill, gap: 30 },
      [
        text("What we need next", { name: "title", width: fill, height: hug, style: darkTitleStyle }),
        grid(
          { name: "ask-grid", width: fill, height: fill, columns: [fr(1), fr(1)], columnGap: 60 },
          [
            column(
              { name: "mvp", width: fill, height: hug, gap: 18 },
              [
                text("Hackathon MVP", { width: fill, height: hug, style: { ...labelStyle, fontSize: 30 } }),
                bullets(["Anchor programs", "updated circuits", "real protocol adapters", "history + disclosure UX"], darkBodyStyle),
              ],
            ),
            column(
              { name: "partners", width: fill, height: hug, gap: 18 },
              [
                text("Support needed", { width: fill, height: hug, style: { ...labelStyle, fontSize: 30 } }),
                bullets(["devnet access", "privacy integration review", "lending risk feedback", "pilot users"], darkBodyStyle),
              ],
            ),
          ],
        ),
        footer("Private lending needs a coordinated stack", "#64748B"),
      ],
    ),
    colors.white,
  );
}

const pptxPath = path.join(outDir, "ShieldLend_Pitch_Deck.pptx");
const pptxBlob = await PresentationFile.exportPptx(presentation);
await pptxBlob.save(pptxPath);

for (let i = 0; i < presentation.slides.items.length; i += 1) {
  const canvas = new Canvas(W, H);
  const ctx = canvas.getContext("2d");
  await drawSlideToCtx(presentation.slides.items[i], presentation, ctx, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { clearBeforeDraw: true });
  await canvas.toFile(path.join(previewDir, `slide-${String(i + 1).padStart(2, "0")}.png`));
}

console.log(JSON.stringify({ pptxPath, previewDir, slides: presentation.slides.items.length }, null, 2));
