//! Zero-dependency OOXML (.docx) generator from Markdown reports.
use crate::{AppError, Result};
use std::io::{Cursor, Write};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn xml_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\t' | '\n' | '\r' => out.push(ch),
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out
}

#[derive(Debug)]
struct InlineRun {
    text: String,
    bold: bool,
    code: bool,
}

fn parse_inline_runs(text: &str) -> Vec<InlineRun> {
    let mut runs = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    let mut buf = String::new();
    let flush = |buf: &mut String, bold: bool, code: bool, runs: &mut Vec<InlineRun>| {
        if !buf.is_empty() {
            runs.push(InlineRun {
                text: std::mem::take(buf),
                bold,
                code,
            });
        }
    };
    while i < chars.len() {
        if i + 1 < chars.len() && chars[i] == '*' && chars[i + 1] == '*' {
            if let Some(end_rel) = chars[i + 2..].windows(2).position(|w| w == ['*', '*']) {
                flush(&mut buf, false, false, &mut runs);
                let inner: String = chars[i + 2..i + 2 + end_rel].iter().collect();
                runs.push(InlineRun {
                    text: inner,
                    bold: true,
                    code: false,
                });
                i = i + 2 + end_rel + 2;
                continue;
            }
        }
        if chars[i] == '`' {
            if let Some(end_rel) = chars[i + 1..].iter().position(|&c| c == '`') {
                flush(&mut buf, false, false, &mut runs);
                let inner: String = chars[i + 1..i + 1 + end_rel].iter().collect();
                runs.push(InlineRun {
                    text: inner,
                    bold: false,
                    code: true,
                });
                i = i + 1 + end_rel + 1;
                continue;
            }
        }
        buf.push(chars[i]);
        i += 1;
    }
    flush(&mut buf, false, false, &mut runs);
    runs
}

fn render_runs_xml(
    text: &str,
    force_bold: bool,
    color_hex: Option<&str>,
    size_half_pt: Option<u32>,
) -> String {
    let runs = parse_inline_runs(text);
    if runs.is_empty() {
        return String::new();
    }
    let mut xml = String::new();
    for run in runs {
        let mut rpr = String::from("<w:rPr>");
        rpr.push_str("<w:rFonts w:ascii=\"PingFang SC\" w:eastAsia=\"PingFang SC\" w:hAnsi=\"PingFang SC\"/>");
        if force_bold || run.bold {
            rpr.push_str("<w:b/>");
        }
        if let Some(hex) = color_hex {
            rpr.push_str(&format!("<w:color w:val=\"{hex}\"/>"));
        } else if run.code {
            rpr.push_str("<w:color w:val=\"3730A3\"/>");
        }
        if let Some(sz) = size_half_pt {
            rpr.push_str(&format!("<w:sz w:val=\"{sz}\"/><w:szCs w:val=\"{sz}\"/>"));
        }
        rpr.push_str("</w:rPr>");
        xml.push_str("<w:r>");
        xml.push_str(&rpr);
        xml.push_str(&format!(
            "<w:t xml:space=\"preserve\">{}</w:t>",
            xml_escape(&run.text)
        ));
        xml.push_str("</w:r>");
    }
    xml
}

fn paragraph_xml(
    text: &str,
    style: Option<&str>,
    force_bold: bool,
    color_hex: Option<&str>,
    size_half_pt: Option<u32>,
    spacing_before: u32,
    spacing_after: u32,
) -> String {
    let mut xml = String::from("<w:p><w:pPr>");
    if let Some(style_id) = style {
        xml.push_str(&format!("<w:pStyle w:val=\"{style_id}\"/>"));
    }
    xml.push_str(&format!(
        "<w:spacing w:before=\"{spacing_before}\" w:after=\"{spacing_after}\" w:line=\"320\" w:lineRule=\"auto\"/>"
    ));
    xml.push_str("</w:pPr>");
    xml.push_str(&render_runs_xml(text, force_bold, color_hex, size_half_pt));
    xml.push_str("</w:p>");
    xml
}

fn split_table_row(line: &str) -> Vec<String> {
    let trimmed = line.trim().trim_start_matches('|').trim_end_matches('|');
    trimmed
        .split('|')
        .map(|cell| cell.trim().to_owned())
        .collect()
}

fn is_table_separator(line: &str) -> bool {
    let trimmed = line.trim();
    if !trimmed.contains('|') && !trimmed.contains('-') {
        return false;
    }
    let cells = split_table_row(trimmed);
    !cells.is_empty()
        && cells
            .iter()
            .all(|cell| !cell.is_empty() && cell.chars().all(|c| c == '-' || c == ':' || c == ' '))
        && cells.iter().any(|cell| cell.contains('-'))
}

fn render_table_xml(rows: &[Vec<String>]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let col_count = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
    let col_width = 9000 / col_count;
    let mut xml = String::from(
        "<w:tbl><w:tblPr>\
        <w:tblW w:w=\"9000\" w:type=\"dxa\"/>\
        <w:tblBorders>\
        <w:top w:val=\"single\" w:sz=\"6\" w:space=\"0\" w:color=\"CBD1DC\"/>\
        <w:left w:val=\"single\" w:sz=\"6\" w:space=\"0\" w:color=\"CBD1DC\"/>\
        <w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"0\" w:color=\"CBD1DC\"/>\
        <w:right w:val=\"single\" w:sz=\"6\" w:space=\"0\" w:color=\"CBD1DC\"/>\
        <w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"E2E5EC\"/>\
        <w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"E2E5EC\"/>\
        </w:tblBorders>\
        </w:tblPr><w:tblGrid>",
    );
    for _ in 0..col_count {
        xml.push_str(&format!("<w:gridCol w:w=\"{col_width}\"/>"));
    }
    xml.push_str("</w:tblGrid>");
    for (row_idx, row) in rows.iter().enumerate() {
        let is_header = row_idx == 0;
        xml.push_str("<w:tr>");
        for col_idx in 0..col_count {
            let cell_text = row.get(col_idx).map(String::as_str).unwrap_or("");
            xml.push_str("<w:tc><w:tcPr>");
            xml.push_str(&format!("<w:tcW w:w=\"{col_width}\" w:type=\"dxa\"/>"));
            if is_header {
                xml.push_str("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"EEF2FF\"/>");
            }
            xml.push_str(
                "<w:tcMar><w:top w:w=\"90\" w:type=\"dxa\"/><w:left w:w=\"120\" w:type=\"dxa\"/>\
                <w:bottom w:w=\"90\" w:type=\"dxa\"/><w:right w:w=\"120\" w:type=\"dxa\"/></w:tcMar></w:tcPr>",
            );
            xml.push_str(&paragraph_xml(
                cell_text,
                None,
                is_header,
                if is_header { Some("3730A3") } else { None },
                Some(20),
                0,
                0,
            ));
            xml.push_str("</w:tc>");
        }
        xml.push_str("</w:tr>");
    }
    xml.push_str("</w:tbl><w:p><w:pPr><w:spacing w:before=\"0\" w:after=\"120\"/></w:pPr></w:p>");
    xml
}

fn build_document_xml(title: &str, markdown: &str) -> String {
    let mut body = String::new();
    if !title.trim().is_empty() {
        body.push_str(&paragraph_xml(
            title.trim(),
            Some("Title"),
            true,
            Some("0F1115"),
            Some(36),
            0,
            180,
        ));
    }

    let lines: Vec<&str> = markdown.lines().collect();
    let mut idx = 0;
    let mut in_code_block = false;
    while idx < lines.len() {
        let raw = lines[idx];
        let trimmed = raw.trim();
        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            idx += 1;
            continue;
        }
        if in_code_block {
            body.push_str(&paragraph_xml(
                raw,
                None,
                false,
                Some("374151"),
                Some(19),
                20,
                40,
            ));
            idx += 1;
            continue;
        }
        if trimmed.is_empty() {
            idx += 1;
            continue;
        }
        if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            body.push_str(
                "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"4\" w:color=\"E2E5EC\"/></w:pBdr>\
                <w:spacing w:before=\"80\" w:after=\"120\"/></w:pPr></w:p>",
            );
            idx += 1;
            continue;
        }
        // Markdown table detection
        if trimmed.contains('|') && idx + 1 < lines.len() && is_table_separator(lines[idx + 1]) {
            let mut rows = vec![split_table_row(trimmed)];
            idx += 2;
            while idx < lines.len() {
                let row_line = lines[idx].trim();
                if row_line.is_empty() || !row_line.contains('|') {
                    break;
                }
                rows.push(split_table_row(row_line));
                idx += 1;
            }
            body.push_str(&render_table_xml(&rows));
            continue;
        }

        if let Some(heading) = trimmed.strip_prefix("### ") {
            body.push_str(&paragraph_xml(
                heading.trim(),
                Some("Heading3"),
                true,
                Some("1F2937"),
                Some(24),
                160,
                80,
            ));
        } else if let Some(heading) = trimmed.strip_prefix("## ") {
            body.push_str(&paragraph_xml(
                heading.trim(),
                Some("Heading2"),
                true,
                Some("3730A3"),
                Some(28),
                200,
                100,
            ));
        } else if let Some(heading) = trimmed.strip_prefix("# ") {
            body.push_str(&paragraph_xml(
                heading.trim(),
                Some("Heading1"),
                true,
                Some("0F1115"),
                Some(32),
                220,
                120,
            ));
        } else if let Some(quote) = trimmed.strip_prefix("> ") {
            body.push_str(&paragraph_xml(
                &format!("▎ {}", quote.trim()),
                None,
                false,
                Some("5B6474"),
                Some(21),
                40,
                80,
            ));
        } else if let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            body.push_str(&paragraph_xml(
                &format!("•  {}", item.trim()),
                None,
                false,
                Some("1F2937"),
                Some(21),
                20,
                60,
            ));
        } else {
            body.push_str(&paragraph_xml(
                trimmed,
                None,
                false,
                Some("1F2937"),
                Some(21),
                20,
                100,
            ));
        }
        idx += 1;
    }

    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
        <w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
        <w:body>{body}\
        <w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>\
        <w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"720\" w:footer=\"720\"/>\
        </w:sectPr></w:body></w:document>"
    )
}

pub fn markdown_to_docx_bytes(title: &str, markdown: &str) -> Result<Vec<u8>> {
    if markdown.trim().is_empty() {
        return Err(AppError::new("VALIDATION", "导出正文不能为空"));
    }
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        zip.start_file("[Content_Types].xml", opts)?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"#,
        )?;

        zip.start_file("_rels/.rels", opts)?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#,
        )?;

        zip.start_file("word/_rels/document.xml.rels", opts)?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#,
        )?;

        zip.start_file("word/styles.xml", opts)?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:rFonts w:ascii="PingFang SC" w:eastAsia="PingFang SC" w:hAnsi="PingFang SC"/><w:sz w:val="21"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>"#,
        )?;

        zip.start_file("word/document.xml", opts)?;
        zip.write_all(build_document_xml(title, markdown).as_bytes())?;

        zip.finish()?;
    }
    Ok(buf.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn generates_valid_docx_roundtrippable_by_parse_file() {
        let md = "# 项目周报\n\n## 核心进展\n- **工单系统**：已完成联调 & 上线评审\n\n| 模块 | 负责人 | 状态 |\n| --- | --- | --- |\n| 账号 | 王磊 | 待确认 |\n";
        let bytes = markdown_to_docx_bytes("客户服务平台周报", md).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("weekly.docx");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(&bytes)
            .unwrap();
        let segments = crate::parse::parse_file(&path, "docx").unwrap();
        let joined = segments
            .iter()
            .map(|s| format!("{}: {}", s.locator, s.text))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(joined.contains("客户服务平台周报"));
        assert!(joined.contains("核心进展"));
        assert!(joined.contains("已完成联调 & 上线评审"));
        assert!(joined.contains("表格 1 / 行 2"));
        assert!(joined.contains("王磊"));
    }
}
