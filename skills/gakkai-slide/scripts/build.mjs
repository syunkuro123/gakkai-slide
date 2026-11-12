#!/usr/bin/env node
// gakkai-slide: 原稿（JSON）から学会・勉強会用のスライド（.pptx）を作り、ルールを点検する
// 使い方: node build.mjs deck.json [-o out.pptx] [--check]
//   --check  pptx を作らず、点検の結果だけを出す
import fs from "node:fs";
import path from "node:path";

// ---- 部品の読み込み（pptxgenjs） ------------------------------------------
async function loadPptx() {
  try {
    return (await import("pptxgenjs")).default;
  } catch (e) {
    const alt = process.env.PPTXGENJS_PATH; // 手元の別フォルダにある場合
    if (alt) return (await import(path.join(alt, "dist/pptxgen.cjs.js"))).default;
    console.error("pptxgenjs が見つかりません。scripts フォルダで `npm install` を実行してください。");
    process.exit(1);
  }
}

// ---- 決まりごと -----------------------------------------------------------
const C = { ink: "1A1A1A", sub: "595959", line: "BFBFBF", faint: "8C8C8C", gray: "A6A6A6" };
const SIZE = { title: 30, body: 24, small: 14, foot: 11 };
const MAX_LINES = 7;
const TITLE_MAX = 30; // 全角換算の文字数
const CHARS_PER_MIN = 300; // 読み原稿の速さの目安（1分あたりの文字数）

// 全角を1、半角を0.5として数える
const width = (s = "") => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) < 0x2e80 ? 0.5 : 1), 0);

// ---- 引数 -----------------------------------------------------------------
const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("-"));
if (!input) {
  console.error("使い方: node build.mjs deck.json [-o out.pptx] [--check]");
  process.exit(1);
}
const oIdx = args.indexOf("-o");
const output = oIdx >= 0 ? args[oIdx + 1] : input.replace(/\.json$/i, ".pptx");
const checkOnly = args.includes("--check");
const baseDir = path.dirname(path.resolve(input));

const deck = JSON.parse(fs.readFileSync(input, "utf8"));
const meta = { aspect: "16:9", accent: "1F4E9A", font: "BIZ UDPGothic", footer: "", mode: "gakkai", ...deck.meta };
const slides = deck.slides || [];
const W = meta.aspect === "4:3" ? 10 : 13.333;
const H = 7.5;
const MX = 0.7; // 左右の余白
const BW = W - MX * 2; // 本文の幅

// ---- 点検 -----------------------------------------------------------------
const warnings = [];
const warn = (i, msg) => warnings.push(`  ${String(i + 1).padStart(2)}枚目: ${msg}`);

// 箱の幅と文字の大きさから、折り返しを含めた行数を見積もる
const linesOf = (text, boxW, pt, indent = 0) => {
  const perLine = Math.max(1, Math.floor(((boxW - indent) * 72) / pt));
  return Math.max(1, Math.ceil(width(text) / perLine));
};
const countItems = (items = [], boxW, pt) =>
  items.reduce((n, it) => {
    const t = typeof it === "string" ? it : it.text;
    const subs = typeof it === "string" ? [] : it.sub || [];
    return n + linesOf(t, boxW, pt, 0.35) + subs.reduce((m, s) => m + linesOf(s, boxW, pt - 2, 0.75), 0);
  }, 0);

function check() {
  let noteChars = 0;
  const hasCoi = slides.some((s) => s.type === "coi");
  if (meta.mode === "gakkai" && !hasCoi) warnings.push("  全体: COI開示のスライドがありません（学会発表では多くの場合必須）");
  slides.forEach((s, i) => {
    const t = s.title || "";
    if (!["title", "coi", "references", "conclusion"].includes(s.type)) {
      if (!t) warn(i, "タイトルがありません");
      if (width(t) > TITLE_MAX) warn(i, `タイトルが長い（${width(t)}字）。結論を${TITLE_MAX}字以内の1文に`);
      else if (linesOf(t, BW, SIZE.title) > 1) warn(i, "タイトルが2行に折り返します。短くすると読みやすい");
      if (/について$|に関して$/.test(t)) warn(i, "タイトルが「〜について」。言いたい結論を書く");
    }
    if (["bullets", "conclusion"].includes(s.type)) {
      const pt = s.type === "conclusion" ? 28 : SIZE.body;
      const n = countItems(s.items, BW, pt) + (s.lead ? linesOf(s.lead, BW, pt) : 0);
      if (n > MAX_LINES) warn(i, `本文が${n}行（折り返し込み）。${MAX_LINES}行までに減らすか2枚に分ける`);
    }
    if (s.type === "twocol") {
      const colW = (BW - 0.6) / 2;
      for (const side of ["left", "right"]) {
        const n = countItems(s[side]?.items, colW, 20);
        if (n > MAX_LINES) warn(i, `${side === "left" ? "左" : "右"}の列が${n}行。${MAX_LINES}行まで`);
      }
    }
    if (s.type === "conclusion" && (s.items || []).length > 3) warn(i, "結論が4つ以上。3つまでに絞る");
    if (["chart", "table", "figure"].includes(s.type) && !s.source && !s.noSource) warn(i, "出典・データの由来（source）がありません");
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(JSON.stringify(s))) warn(i, "絵文字が入っています");
    noteChars += width(s.notes || "") ;
  });
  const minutes = noteChars / CHARS_PER_MIN;
  return { minutes, noteChars };
}

const { minutes, noteChars } = check();

// ---- 描く部品 -------------------------------------------------------------
const PptxGenJS = checkOnly ? null : await loadPptx();
const pptx = checkOnly ? null : new PptxGenJS();
const F = meta.font;
const T = (o = {}) => ({ fontFace: F, color: C.ink, margin: 0, lang: "ja-JP", ...o });

function titleBar(sl, text) {
  sl.addText(text, T({ x: MX, y: 0.42, w: BW, h: 0.95, fontSize: SIZE.title, bold: true, valign: "bottom" }));
  sl.addShape(pptx.ShapeType.line, { x: MX, y: 1.5, w: BW, h: 0, line: { color: C.line, width: 0.75 } });
}
function footer(sl, i) {
  if (meta.footer) sl.addText(meta.footer, T({ x: MX, y: 6.95, w: BW - 1, h: 0.3, fontSize: SIZE.foot, color: C.faint }));
  sl.addText(String(i + 1), T({ x: W - MX - 1, y: 6.95, w: 1, h: 0.3, fontSize: SIZE.foot, color: C.faint, align: "right" }));
}
function sourceLine(sl, s, y = 6.5) {
  if (s.source) sl.addText(s.source, T({ x: MX, y, w: BW, h: 0.32, fontSize: 12, color: C.sub }));
}
function runs(items, pt, numbered = false) {
  const out = [];
  items.forEach((it) => {
    const text = typeof it === "string" ? it : it.text;
    out.push({
      text,
      options: {
        bullet: numbered ? { type: "number", style: "arabicPeriod" } : { indent: 22 },
        fontSize: pt, paraSpaceAfter: 10, breakLine: true,
      },
    });
    for (const sub of (typeof it === "string" ? [] : it.sub || [])) {
      out.push({ text: sub, options: { bullet: { indent: 22 }, indentLevel: 1, fontSize: pt - 2, color: C.sub, paraSpaceAfter: 6, breakLine: true } });
    }
  });
  return out;
}

const draw = {
  title(sl, s) {
    if (s.event) sl.addText(s.event, T({ x: MX, y: 0.9, w: BW, h: 0.4, fontSize: 16, color: C.sub }));
    sl.addText(s.title, T({ x: MX, y: 1.8, w: BW, h: 1.9, fontSize: 36, bold: true, valign: "bottom", lineSpacingMultiple: 1.15 }));
    if (s.subtitle) sl.addText(s.subtitle, T({ x: MX, y: 3.8, w: BW, h: 0.5, fontSize: 20, color: C.sub }));
    sl.addShape(pptx.ShapeType.line, { x: MX, y: 4.6, w: 1.2, h: 0, line: { color: C.ink, width: 1 } });
    if (s.authors) sl.addText(s.authors, T({ x: MX, y: 4.85, w: BW, h: 0.5, fontSize: 20 }));
    if (s.affiliations?.length)
      sl.addText(s.affiliations.join("\n"), T({ x: MX, y: 5.4, w: BW, h: 1.0, fontSize: SIZE.small, color: C.sub, valign: "top", lineSpacingMultiple: 1.3 }));
  },
  coi(sl, s) {
    titleBar(sl, s.title || "COI開示");
    const lines = [];
    if (s.presenter) lines.push({ text: `筆頭演者：${s.presenter}`, options: { fontSize: 22, color: C.sub, breakLine: true, paraSpaceAfter: 24 } });
    const body = s.items?.length ? s.items : [s.text || "演題発表に関連し、開示すべきCOI関係にある企業などはありません。"];
    body.forEach((b) => lines.push({ text: b, options: { fontSize: SIZE.body, breakLine: true, paraSpaceAfter: 10 } }));
    sl.addText(lines, T({ x: MX, y: 2.2, w: BW, h: 3.6, valign: "top", lineSpacingMultiple: 1.3 }));
  },
  bullets(sl, s) {
    titleBar(sl, s.title);
    let y = 1.85;
    if (s.lead) {
      sl.addText(s.lead, T({ x: MX, y, w: BW, h: 0.6, fontSize: SIZE.body, color: C.sub }));
      y += 0.8;
    }
    sl.addText(runs(s.items || [], SIZE.body), T({ x: MX, y, w: BW, h: 6.4 - y, valign: "top", lineSpacingMultiple: 1.25 }));
    if (s.note) sl.addText(s.note, T({ x: MX, y: 6.2, w: BW, h: 0.35, fontSize: SIZE.small, color: C.sub }));
    sourceLine(sl, s);
  },
  twocol(sl, s) {
    titleBar(sl, s.title);
    const colW = (BW - 0.6) / 2;
    ["left", "right"].forEach((side, k) => {
      const c = s[side] || {};
      const x = MX + k * (colW + 0.6);
      sl.addText(c.heading || "", T({ x, y: 1.85, w: colW, h: 0.55, fontSize: 22, bold: true, color: c.accent ? meta.accent : C.ink }));
      sl.addShape(pptx.ShapeType.line, { x, y: 2.45, w: colW, h: 0, line: { color: c.accent ? meta.accent : C.ink, width: c.accent ? 2 : 1 } });
      sl.addText(runs(c.items || [], 20), T({ x, y: 2.65, w: colW, h: 3.7, valign: "top", lineSpacingMultiple: 1.25 }));
    });
    sourceLine(sl, s);
  },
  stat(sl, s) {
    titleBar(sl, s.title);
    const items = s.items || [];
    const n = items.length;
    const gap = s.arrow ? 0.9 : 0.4;
    const colW = (BW - gap * (n - 1)) / n;
    items.forEach((it, k) => {
      const x = MX + k * (colW + gap);
      sl.addText(it.label || "", T({ x, y: 2.2, w: colW, h: 0.5, fontSize: 20, color: C.sub, align: "center" }));
      sl.addText(it.value, T({ x, y: 2.8, w: colW, h: 1.5, fontSize: 60, bold: true, color: it.accent ? meta.accent : C.ink, align: "center", valign: "middle" }));
      if (it.detail) sl.addText(it.detail, T({ x, y: 4.4, w: colW, h: 0.5, fontSize: 16, color: C.sub, align: "center" }));
      if (s.arrow && k < n - 1) sl.addText("→", T({ x: x + colW, y: 2.8, w: gap, h: 1.5, fontSize: 36, color: C.gray, align: "center", valign: "middle" }));
    });
    if (s.note) sl.addText(s.note, T({ x: MX, y: 5.3, w: BW, h: 0.8, fontSize: 18, color: C.ink, align: "center", valign: "top" }));
    sourceLine(sl, s);
  },
  // 棒グラフは図形で描く（PowerPoint・Keynote・Googleスライドのどれで開いても同じに見えるように）
  chart(sl, s) {
    titleBar(sl, s.title);
    const ch = s.chart;
    const hi = ch.highlight ?? -1;
    const vals = ch.values;
    const n = vals.length;
    const max = Math.max(...vals.map(Math.abs)) || 1;
    const hasNote = Boolean(s.note);
    const base = hasNote ? 5.15 : 5.65; // 棒の足もとの線
    const top = 2.45; // いちばん高い棒の上端
    const slot = BW / n;
    const barW = Math.min(slot * 0.55, 1.8);
    vals.forEach((v, k) => {
      const color = k === hi ? meta.accent : C.gray;
      const h = Math.max(0.02, (Math.abs(v) / max) * (base - top));
      const x = MX + slot * k + (slot - barW) / 2;
      sl.addShape(pptx.ShapeType.rect, { x, y: base - h, w: barW, h, fill: { color }, line: { color, width: 0 } });
      sl.addText(`${v}${ch.suffix || ""}`, T({ x: MX + slot * k, y: base - h - 0.5, w: slot, h: 0.45, fontSize: 20, bold: k === hi, color: k === hi ? meta.accent : C.ink, align: "center", valign: "bottom" }));
      sl.addText(ch.categories[k], T({ x: MX + slot * k, y: base + 0.1, w: slot, h: 0.45, fontSize: 18, align: "center" }));
    });
    sl.addShape(pptx.ShapeType.line, { x: MX, y: base, w: BW, h: 0, line: { color: C.ink, width: 1 } });
    if (ch.unit) sl.addText(`単位：${ch.unit}`, T({ x: MX, y: 1.62, w: BW, h: 0.3, fontSize: 12, color: C.sub, align: "right" }));
    if (hasNote) sl.addText(s.note, T({ x: MX, y: 5.9, w: BW, h: 0.5, fontSize: 18 }));
    sourceLine(sl, s);
  },
  table(sl, s) {
    titleBar(sl, s.title);
    const none = { type: "none" };
    const thick = { type: "solid", pt: 1.5, color: C.ink };
    const thin = { type: "solid", pt: 0.75, color: C.ink };
    const last = s.rows.length - 1;
    const hiRow = s.highlightRow ?? -1;
    const head = s.columns.map((c, k) => ({
      text: c,
      options: { bold: true, border: [thick, none, thin, none], align: k === 0 ? "left" : "center" },
    }));
    const body = s.rows.map((r, ri) =>
      r.map((c, k) => ({
        text: String(c),
        options: {
          border: [none, none, ri === last ? thick : none, none],
          align: k === 0 ? "left" : "center",
          color: ri === hiRow ? meta.accent : C.ink,
          bold: ri === hiRow,
        },
      })),
    );
    // 列の幅は比率として扱い、ページの幅に合わせる（16:9 と 4:3 のどちらでもはみ出さない）
    const ratio = s.colW || s.columns.map((_, k) => (k === 0 ? 2 : 1));
    const sum = ratio.reduce((a, b) => a + b, 0);
    const colW = ratio.map((r) => (r / sum) * BW);
    sl.addTable([head, ...body], {
      x: MX, y: 1.95, w: BW, colW, fontFace: F, fontSize: s.fontSize || 20, color: C.ink,
      rowH: 0.55, valign: "middle", margin: [0.04, 0.1, 0.04, 0.1],
    });
    if (s.note) sl.addText(s.note, T({ x: MX, y: 6.1, w: BW, h: 0.4, fontSize: SIZE.small, color: C.sub }));
    sourceLine(sl, s);
  },
  figure(sl, s) {
    titleBar(sl, s.title);
    const p = path.resolve(baseDir, s.image);
    sl.addImage({ path: p, x: MX, y: 1.8, w: BW, h: 4.2, sizing: { type: "contain", w: BW, h: 4.2 } });
    if (s.caption) sl.addText(s.caption, T({ x: MX, y: 6.05, w: BW, h: 0.4, fontSize: 16, color: C.sub, align: "center" }));
    sourceLine(sl, s);
  },
  conclusion(sl, s) {
    titleBar(sl, s.title || "結論");
    sl.addText(runs(s.items || [], 28, true), T({ x: MX, y: 2.0, w: BW, h: 4.0, valign: "top", lineSpacingMultiple: 1.3 }));
    if (s.thanks) sl.addText(s.thanks, T({ x: MX, y: 6.2, w: BW, h: 0.4, fontSize: SIZE.small, color: C.sub }));
  },
  references(sl, s) {
    titleBar(sl, s.title || "文献");
    sl.addText(runs(s.items || [], SIZE.small, true), T({ x: MX, y: 1.85, w: BW, h: 4.8, valign: "top", color: C.sub, lineSpacingMultiple: 1.2 }));
  },
};

// ---- 組み立て -------------------------------------------------------------
if (!checkOnly) {
  pptx.layout = meta.aspect === "4:3" ? "LAYOUT_4x3" : "LAYOUT_WIDE";
  pptx.theme = { headFontFace: F, bodyFontFace: F, lang: "ja-JP" };
  pptx.title = meta.title || slides[0]?.title || "";
  slides.forEach((s, i) => {
    const sl = pptx.addSlide();
    sl.background = { color: "FFFFFF" };
    const fn = draw[s.type];
    if (!fn) throw new Error(`${i + 1}枚目: 型「${s.type}」はありません（${Object.keys(draw).join(" / ")}）`);
    fn(sl, s);
    if (s.type !== "title") footer(sl, i);
    if (s.notes) sl.addNotes(s.notes);
  });
  await pptx.writeFile({ fileName: output });
}

// ---- 報告 -----------------------------------------------------------------
console.log(checkOnly ? "点検のみ" : `できました: ${output}`);
console.log(`  枚数: ${slides.length}枚`);
if (noteChars) {
  const lim = meta.time_limit_min ? ` / 持ち時間 ${meta.time_limit_min}分` : "";
  console.log(`  読み原稿: ${Math.round(noteChars)}字 → 約${minutes.toFixed(1)}分（1分${CHARS_PER_MIN}字で計算）${lim}`);
  if (meta.time_limit_min && minutes > meta.time_limit_min) warnings.push(`  全体: 読み原稿が持ち時間を超えています（約${minutes.toFixed(1)}分 > ${meta.time_limit_min}分）`);
}
if (warnings.length) {
  console.log(`点検で気になった所（${warnings.length}件）:`);
  warnings.forEach((w) => console.log(w));
} else {
  console.log("点検: 問題なし");
}
