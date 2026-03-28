#!/usr/bin/env python3
"""Generate PDF from session progress markdown."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, Preformatted
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER
import re

OUTPUT = "session-progress-2026-03-28.pdf"
INPUT  = "session-progress-2026-03-28.md"

doc = SimpleDocTemplate(
    OUTPUT,
    pagesize=A4,
    rightMargin=20*mm, leftMargin=20*mm,
    topMargin=20*mm, bottomMargin=20*mm,
)

styles = getSampleStyleSheet()

# Custom styles
title_style = ParagraphStyle("Title2", parent=styles["Heading1"],
    fontSize=20, spaceAfter=6, textColor=colors.HexColor("#1a1a2e"))
h1 = ParagraphStyle("H1", parent=styles["Heading1"],
    fontSize=15, spaceBefore=14, spaceAfter=4, textColor=colors.HexColor("#16213e"))
h2 = ParagraphStyle("H2", parent=styles["Heading2"],
    fontSize=12, spaceBefore=10, spaceAfter=3, textColor=colors.HexColor("#0f3460"))
h3 = ParagraphStyle("H3", parent=styles["Heading3"],
    fontSize=10, spaceBefore=8, spaceAfter=2, textColor=colors.HexColor("#533483"))
body = ParagraphStyle("Body2", parent=styles["Normal"],
    fontSize=9, spaceAfter=4, leading=13)
code = ParagraphStyle("Code", parent=styles["Code"],
    fontSize=7.5, fontName="Courier", backColor=colors.HexColor("#f5f5f5"),
    borderColor=colors.HexColor("#dddddd"), borderWidth=0.5, borderPadding=4,
    spaceAfter=6, leading=11)
bullet = ParagraphStyle("Bullet", parent=body,
    leftIndent=12, bulletIndent=4, spaceAfter=2)

def bold_inline(text):
    """Convert **bold** and `code` in inline text to ReportLab markup."""
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'`(.+?)`', r'<font name="Courier" size="8">\1</font>', text)
    return text

story = []

with open(INPUT, encoding="utf-8") as f:
    lines = f.readlines()

in_code = False
code_buf = []
i = 0

while i < len(lines):
    raw = lines[i].rstrip("\n")

    # Code block
    if raw.strip().startswith("```"):
        if not in_code:
            in_code = True
            code_buf = []
        else:
            in_code = False
            code_text = "\n".join(code_buf)
            story.append(Preformatted(code_text, code))
        i += 1
        continue

    if in_code:
        code_buf.append(raw)
        i += 1
        continue

    # Table (markdown pipe table)
    if raw.strip().startswith("|") and "|" in raw:
        table_rows = []
        while i < len(lines) and lines[i].strip().startswith("|"):
            row_raw = lines[i].strip()
            if re.match(r'^\|[-| :]+\|$', row_raw):
                i += 1
                continue
            cells = [c.strip() for c in row_raw.strip("|").split("|")]
            cells = [Paragraph(bold_inline(c), body) for c in cells]
            table_rows.append(cells)
            i += 1
        if table_rows:
            t = Table(table_rows, repeatRows=1, hAlign="LEFT")
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8eaf6")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#1a1a2e")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
                ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#cccccc")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1),
                    [colors.white, colors.HexColor("#f9f9ff")]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]))
            story.append(t)
            story.append(Spacer(1, 4))
        continue

    # Headings
    if raw.startswith("# "):
        story.append(Paragraph(raw[2:], title_style))
        story.append(HRFlowable(width="100%", thickness=1.5, color=colors.HexColor("#1a1a2e")))
        story.append(Spacer(1, 4))
    elif raw.startswith("## "):
        story.append(Paragraph(bold_inline(raw[3:]), h1))
        story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#aaaacc")))
    elif raw.startswith("### "):
        story.append(Paragraph(bold_inline(raw[4:]), h2))
    elif raw.startswith("#### "):
        story.append(Paragraph(bold_inline(raw[5:]), h3))
    elif raw.startswith("- ") or raw.startswith("* "):
        story.append(Paragraph(u"\u2022 " + bold_inline(raw[2:]), bullet))
    elif raw.startswith("---"):
        story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#999999")))
        story.append(Spacer(1, 2))
    elif raw.strip() == "":
        story.append(Spacer(1, 4))
    else:
        story.append(Paragraph(bold_inline(raw), body))

    i += 1

doc.build(story)
print(f"PDF generated: {OUTPUT}")
