use crate::{AppError, Result};
use quick_xml::{events::Event, Reader};
use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Read},
    path::Path,
};

const MAX_EXTRACTED_XML_BYTES: u64 = 30 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct ParsedSegment {
    pub locator: String,
    pub text: String,
}

pub(crate) fn parse_file(path: &Path, kind: &str) -> Result<Vec<ParsedSegment>> {
    let bytes = fs::read(path)?;
    let result = match kind {
        "txt" | "md" => {
            let text = String::from_utf8(bytes).map_err(|_| {
                AppError::new("ENCODING", "仅支持 UTF-8 文本，请另存为 UTF-8 后导入")
            })?;
            text.split_inclusive('\n')
                .enumerate()
                .filter(|(_, s)| !s.trim().is_empty())
                .map(|(n, s)| ParsedSegment {
                    locator: format!("第 {} 行", n + 1),
                    text: s.to_owned(),
                })
                .collect()
        }
        "docx" => parse_docx(&bytes)?,
        "pdf" => parse_pdf(&bytes)?,
        "csv" => parse_csv(&bytes)?,
        "xlsx" => parse_xlsx(&bytes)?,
        "pptx" => parse_pptx(&bytes)?,
        "eml" => parse_eml(&bytes)?,
        _ => {
            return Err(AppError::new(
                "UNSUPPORTED_FILE",
                "支持 TXT、MD、DOCX、文本 PDF、CSV、XLSX、PPTX 和 EML 邮件",
            ))
        }
    };
    if result.is_empty() {
        return Err(AppError::new(
            "EMPTY_DOCUMENT",
            if kind == "pdf" {
                "PDF 未提取到文字；扫描件暂不支持 OCR，请粘贴文本"
            } else {
                "资料中没有可提取的文字"
            },
        ));
    }
    if result.len() > 50_000
        || result
            .iter()
            .map(|segment| segment.text.len())
            .sum::<usize>()
            > 30 * 1024 * 1024
    {
        return Err(AppError::new(
            "DOCUMENT_LIMIT",
            "资料正文过多，请拆分后导入",
        ));
    }
    Ok(result)
}

fn read_zip_text(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    name: &str,
    remaining_budget: &mut u64,
    err_code: &str,
) -> Result<Option<String>> {
    let Ok(entry) = archive.by_name(name) else {
        return Ok(None);
    };
    if entry.size() > *remaining_budget {
        return Err(AppError::new("DOCUMENT_LIMIT", "文档解压后正文过大"));
    }
    let mut xml = String::new();
    let mut limited = entry.take(*remaining_budget + 1);
    limited.read_to_string(&mut xml)?;
    if xml.len() as u64 > *remaining_budget {
        return Err(AppError::new("DOCUMENT_LIMIT", "文档解压后正文过大"));
    }
    *remaining_budget = remaining_budget.saturating_sub(xml.len() as u64);
    if xml.is_empty() {
        return Err(AppError::new(err_code, "文档内部 XML 为空"));
    }
    Ok(Some(xml))
}

fn decode_xml_text(e: &quick_xml::events::BytesText<'_>, err_code: &str) -> Result<String> {
    let decoded = e
        .decode()
        .map_err(|_| AppError::new(err_code, "文档文字编码损坏，暂时无法解析"))?;
    quick_xml::escape::unescape(&decoded)
        .map(|s| s.into_owned())
        .map_err(|_| AppError::new(err_code, "文档内容格式异常，暂时无法解析"))
}

fn decode_xml_ref(e: &quick_xml::events::BytesRef<'_>, err_code: &str) -> Result<String> {
    let name = e
        .decode()
        .map_err(|_| AppError::new(err_code, "文档字符引用损坏，暂时无法解析"))?;
    let escaped = format!("&{name};");
    quick_xml::escape::unescape(&escaped)
        .map(|s| s.into_owned())
        .map_err(|_| AppError::new(err_code, "文档字符引用异常，暂时无法解析"))
}

fn parse_docx(bytes: &[u8]) -> Result<Vec<ParsedSegment>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    let mut budget = MAX_EXTRACTED_XML_BYTES;
    let xml = read_zip_text(
        &mut archive,
        "word/document.xml",
        &mut budget,
        "INVALID_DOCX",
    )?
    .ok_or_else(|| AppError::new("INVALID_DOCX", "DOCX 缺少正文"))?;
    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(false);
    let mut segments = Vec::new();
    let (mut text, mut paragraph, mut table, mut row, mut in_table, mut in_text) =
        (String::new(), 0, 0, 0, 0, false);
    let mut heading = false;
    loop {
        match reader.read_event().map_err(|_| {
            AppError::new(
                "INVALID_DOCX",
                "Word 文档结构损坏或受密码保护，暂时无法解析",
            )
        })? {
            Event::Start(e) => match e.local_name().as_ref() {
                b"tbl" => {
                    table += 1;
                    in_table += 1;
                    row = 0;
                }
                b"tr" => row += 1,
                b"p" => {
                    heading = false;
                    text.clear();
                    paragraph += 1;
                }
                b"t" => in_text = true,
                b"tab" => text.push('\t'),
                b"br" => text.push('\n'),
                _ => {}
            },
            Event::Empty(e) if e.local_name().as_ref() == b"pStyle" => {
                heading = e.attributes().flatten().any(|a| {
                    a.key.local_name().as_ref() == b"val" && {
                        let value = String::from_utf8_lossy(&a.value).to_lowercase();
                        value.starts_with("heading") || value.starts_with("标题")
                    }
                });
            }
            Event::Empty(e) => match e.local_name().as_ref() {
                b"tab" => text.push('\t'),
                b"br" => text.push('\n'),
                _ => {}
            },
            Event::Text(e) if in_text => text.push_str(&decode_xml_text(&e, "INVALID_DOCX")?),
            Event::GeneralRef(e) if in_text => text.push_str(&decode_xml_ref(&e, "INVALID_DOCX")?),
            Event::End(e) => match e.local_name().as_ref() {
                b"t" => in_text = false,
                b"tbl" => in_table -= 1,
                b"p" if !text.trim().is_empty() => segments.push(ParsedSegment {
                    locator: if in_table > 0 {
                        format!("表格 {table} / 行 {row} / 段落 {paragraph}")
                    } else if heading {
                        format!("标题 / 段落 {paragraph}")
                    } else {
                        format!("段落 {paragraph}")
                    },
                    text: std::mem::take(&mut text),
                }),
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(segments)
}

fn parse_pdf(bytes: &[u8]) -> Result<Vec<ParsedSegment>> {
    let pages = pdf_extract::extract_text_from_mem_by_pages(bytes).map_err(|_| {
        AppError::new(
            "INVALID_PDF",
            "PDF 暂时无法提取文字（可能为扫描件、已加密或文件损坏）",
        )
    })?;
    Ok(pages
        .into_iter()
        .enumerate()
        .filter(|(_, text)| !text.trim().is_empty())
        .map(|(n, text)| ParsedSegment {
            locator: format!("第 {} 页", n + 1),
            text,
        })
        .collect())
}

fn format_tabular_rows(rows: &[Vec<String>], prefix: &str) -> Vec<ParsedSegment> {
    let non_empty: Vec<(usize, &Vec<String>)> = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| row.iter().any(|cell| !cell.trim().is_empty()))
        .collect();
    if non_empty.is_empty() {
        return Vec::new();
    }
    let headers = non_empty[0].1;
    let mut segments = Vec::new();
    if non_empty.len() == 1 {
        let joined = headers
            .iter()
            .map(|c| c.trim())
            .filter(|c| !c.is_empty())
            .collect::<Vec<_>>()
            .join(" | ");
        if !joined.is_empty() {
            segments.push(ParsedSegment {
                locator: format!("{prefix}第 {} 行", non_empty[0].0 + 1),
                text: joined,
            });
        }
        return segments;
    }
    for (row_idx, row) in non_empty.into_iter().skip(1) {
        let mut parts = Vec::new();
        for (col_idx, cell) in row.iter().enumerate() {
            let val = cell.trim();
            if val.is_empty() {
                continue;
            }
            if let Some(header) = headers
                .get(col_idx)
                .map(|h| h.trim())
                .filter(|h| !h.is_empty())
            {
                parts.push(format!("{header}: {val}"));
            } else {
                parts.push(val.to_owned());
            }
        }
        if !parts.is_empty() {
            segments.push(ParsedSegment {
                locator: format!("{prefix}第 {} 行", row_idx + 1),
                text: parts.join(" | "),
            });
        }
    }
    segments
}

fn parse_csv(bytes: &[u8]) -> Result<Vec<ParsedSegment>> {
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("ENCODING", "CSV 仅支持 UTF-8 编码，请另存为 UTF-8 后导入"))?;
    let clean = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut current_row: Vec<String> = Vec::new();
    let mut current_cell = String::new();
    let mut in_quotes = false;
    let mut chars = clean.chars().peekable();

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    current_cell.push('"');
                } else {
                    in_quotes = false;
                }
            } else if ch == '\r' {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                current_cell.push(' ');
            } else if ch == '\n' {
                current_cell.push(' ');
            } else {
                current_cell.push(ch);
            }
        } else {
            match ch {
                '"' if current_cell.is_empty() => in_quotes = true,
                ',' => {
                    current_row.push(std::mem::take(&mut current_cell));
                }
                '\r' => {
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    current_row.push(std::mem::take(&mut current_cell));
                    rows.push(std::mem::take(&mut current_row));
                }
                '\n' => {
                    current_row.push(std::mem::take(&mut current_cell));
                    rows.push(std::mem::take(&mut current_row));
                }
                other => current_cell.push(other),
            }
        }
    }
    if !current_cell.is_empty() || !current_row.is_empty() {
        current_row.push(current_cell);
        rows.push(current_row);
    }

    Ok(format_tabular_rows(&rows, ""))
}

fn col_index_from_ref(cell_ref: &str) -> Option<usize> {
    let letters: String = cell_ref
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect();
    if letters.is_empty() {
        return None;
    }
    let mut idx = 0usize;
    for ch in letters.bytes() {
        let upper = ch.to_ascii_uppercase();
        if !upper.is_ascii_uppercase() {
            return None;
        }
        idx = idx * 26 + (upper - b'A') as usize + 1;
    }
    idx.checked_sub(1)
}

fn parse_xlsx_shared_strings(xml: &str) -> Result<Vec<String>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut strings = Vec::new();
    let mut current = String::new();
    let mut in_si = false;
    let mut in_t = false;
    loop {
        match reader.read_event().map_err(|_| {
            AppError::new(
                "INVALID_XLSX",
                "Excel 表格结构损坏或受密码保护，暂时无法解析",
            )
        })? {
            Event::Start(e) => match e.local_name().as_ref() {
                b"si" => {
                    in_si = true;
                    current.clear();
                }
                b"t" if in_si => in_t = true,
                _ => {}
            },
            Event::Text(e) if in_si && in_t => {
                current.push_str(&decode_xml_text(&e, "INVALID_XLSX")?);
            }
            Event::GeneralRef(e) if in_si && in_t => {
                current.push_str(&decode_xml_ref(&e, "INVALID_XLSX")?);
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"t" => in_t = false,
                b"si" => {
                    in_si = false;
                    strings.push(std::mem::take(&mut current));
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(strings)
}

fn parse_xlsx_sheets(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    budget: &mut u64,
) -> Result<Vec<(String, String)>> {
    let mut rels_map = HashMap::new();
    if let Some(rels_xml) = read_zip_text(
        archive,
        "xl/_rels/workbook.xml.rels",
        budget,
        "INVALID_XLSX",
    )? {
        let mut reader = Reader::from_str(&rels_xml);
        loop {
            match reader.read_event().map_err(|_| {
                AppError::new(
                    "INVALID_XLSX",
                    "XLSX 表格关系清单解析失败，请确认文件未损坏",
                )
            })? {
                Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"Relationship" => {
                    let (mut id, mut target) = (String::new(), String::new());
                    for attr in e.attributes().flatten() {
                        match attr.key.local_name().as_ref() {
                            b"Id" => id = String::from_utf8_lossy(&attr.value).into_owned(),
                            b"Target" => target = String::from_utf8_lossy(&attr.value).into_owned(),
                            _ => {}
                        }
                    }
                    if !id.is_empty() && !target.is_empty() {
                        let normalized = if let Some(stripped) = target.strip_prefix('/') {
                            stripped.to_owned()
                        } else if target.starts_with("xl/") {
                            target
                        } else {
                            format!("xl/{target}")
                        };
                        rels_map.insert(id, normalized);
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
    }

    let mut ordered = Vec::new();
    if let Some(wb_xml) = read_zip_text(archive, "xl/workbook.xml", budget, "INVALID_XLSX")? {
        let mut reader = Reader::from_str(&wb_xml);
        loop {
            match reader.read_event().map_err(|_| {
                AppError::new(
                    "INVALID_XLSX",
                    "XLSX 表格关系清单解析失败，请确认文件未损坏",
                )
            })? {
                Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"sheet" => {
                    let (mut name, mut rid) = (String::new(), String::new());
                    for attr in e.attributes().flatten() {
                        match attr.key.local_name().as_ref() {
                            b"name" => name = String::from_utf8_lossy(&attr.value).into_owned(),
                            b"id" => rid = String::from_utf8_lossy(&attr.value).into_owned(),
                            _ => {}
                        }
                    }
                    if let Some(path) = rels_map.get(&rid) {
                        ordered.push((
                            if name.is_empty() {
                                "工作表".to_owned()
                            } else {
                                name
                            },
                            path.clone(),
                        ));
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
    }

    if ordered.is_empty() {
        let mut sheet_names: Vec<String> = (0..archive.len())
            .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_owned()))
            .filter(|n| n.starts_with("xl/worksheets/sheet") && n.ends_with(".xml"))
            .collect();
        sheet_names.sort_by_key(|n| {
            n.trim_start_matches("xl/worksheets/sheet")
                .trim_end_matches(".xml")
                .parse::<usize>()
                .unwrap_or(usize::MAX)
        });
        for (i, path) in sheet_names.into_iter().enumerate() {
            ordered.push((format!("Sheet{}", i + 1), path));
        }
    }
    Ok(ordered)
}

fn parse_xlsx(bytes: &[u8]) -> Result<Vec<ParsedSegment>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| AppError::new("INVALID_XLSX", "无法打开 XLSX 表格文件"))?;
    let mut budget = MAX_EXTRACTED_XML_BYTES;
    let shared_strings = match read_zip_text(
        &mut archive,
        "xl/sharedStrings.xml",
        &mut budget,
        "INVALID_XLSX",
    )? {
        Some(xml) => parse_xlsx_shared_strings(&xml)?,
        None => Vec::new(),
    };
    let sheets = parse_xlsx_sheets(&mut archive, &mut budget)?;
    if sheets.is_empty() {
        return Err(AppError::new("INVALID_XLSX", "XLSX 缺少工作表"));
    }

    let mut all_segments = Vec::new();
    for (sheet_name, path) in sheets {
        let Some(xml) = read_zip_text(&mut archive, &path, &mut budget, "INVALID_XLSX")? else {
            continue;
        };
        let mut reader = Reader::from_str(&xml);
        reader.config_mut().trim_text(false);
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut current_row: Vec<String> = Vec::new();
        let mut cell_type = String::new();
        let mut cell_col: Option<usize> = None;
        let mut in_v = false;
        let mut in_t = false;
        let mut cell_buf = String::new();

        loop {
            match reader.read_event().map_err(|_| {
                AppError::new(
                    "INVALID_XLSX",
                    "XLSX 表格关系清单解析失败，请确认文件未损坏",
                )
            })? {
                Event::Start(e) => match e.local_name().as_ref() {
                    b"row" => current_row.clear(),
                    b"c" => {
                        cell_type.clear();
                        cell_col = None;
                        cell_buf.clear();
                        for attr in e.attributes().flatten() {
                            match attr.key.local_name().as_ref() {
                                b"t" => {
                                    cell_type = String::from_utf8_lossy(&attr.value).into_owned()
                                }
                                b"r" => {
                                    cell_col =
                                        col_index_from_ref(&String::from_utf8_lossy(&attr.value))
                                }
                                _ => {}
                            }
                        }
                    }
                    b"v" => {
                        in_v = true;
                        cell_buf.clear();
                    }
                    b"t" if cell_type == "inlineStr" => {
                        in_t = true;
                    }
                    _ => {}
                },
                Event::Text(e) if in_v || in_t => {
                    cell_buf.push_str(&decode_xml_text(&e, "INVALID_XLSX")?);
                }
                Event::GeneralRef(e) if in_v || in_t => {
                    cell_buf.push_str(&decode_xml_ref(&e, "INVALID_XLSX")?);
                }
                Event::End(e) => match e.local_name().as_ref() {
                    b"v" => in_v = false,
                    b"t" => in_t = false,
                    b"c" => {
                        let resolved = if cell_type == "s" {
                            cell_buf
                                .trim()
                                .parse::<usize>()
                                .ok()
                                .and_then(|idx| shared_strings.get(idx))
                                .cloned()
                                .unwrap_or_default()
                        } else {
                            std::mem::take(&mut cell_buf)
                        };
                        if let Some(col_idx) = cell_col {
                            if col_idx < 256 {
                                if current_row.len() <= col_idx {
                                    current_row.resize(col_idx + 1, String::new());
                                }
                                current_row[col_idx] = resolved;
                            }
                        } else {
                            current_row.push(resolved);
                        }
                    }
                    b"row" => rows.push(std::mem::take(&mut current_row)),
                    _ => {}
                },
                Event::Eof => break,
                _ => {}
            }
        }
        all_segments.extend(format_tabular_rows(
            &rows,
            &format!("工作表「{sheet_name}」 / "),
        ));
    }
    Ok(all_segments)
}

fn extract_pptx_xml_paragraphs(xml: &str) -> Result<Vec<String>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut paragraphs = Vec::new();
    let mut current = String::new();
    let mut in_p = false;
    let mut in_t = false;
    loop {
        match reader.read_event().map_err(|_| {
            AppError::new(
                "INVALID_PPTX",
                "PPT 演示文稿结构损坏或受密码保护，暂时无法解析",
            )
        })? {
            Event::Start(e) => match e.local_name().as_ref() {
                b"p" => {
                    in_p = true;
                    current.clear();
                }
                b"t" if in_p => in_t = true,
                b"br" if in_p => current.push(' '),
                _ => {}
            },
            Event::Empty(e) if in_p && e.local_name().as_ref() == b"br" => current.push(' '),
            Event::Text(e) if in_p && in_t => {
                current.push_str(&decode_xml_text(&e, "INVALID_PPTX")?);
            }
            Event::GeneralRef(e) if in_p && in_t => {
                current.push_str(&decode_xml_ref(&e, "INVALID_PPTX")?);
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"t" => in_t = false,
                b"p" => {
                    in_p = false;
                    let trimmed = current.trim();
                    if !trimmed.is_empty() {
                        paragraphs.push(trimmed.to_owned());
                    }
                    current.clear();
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(paragraphs)
}

fn parse_pptx(bytes: &[u8]) -> Result<Vec<ParsedSegment>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| AppError::new("INVALID_PPTX", "无法打开 PPTX 演示文稿"))?;
    let mut budget = MAX_EXTRACTED_XML_BYTES;

    let mut slide_paths: Vec<(usize, String)> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_owned()))
        .filter_map(|name| {
            let num_str = name
                .strip_prefix("ppt/slides/slide")?
                .strip_suffix(".xml")?;
            let num = num_str.parse::<usize>().ok()?;
            Some((num, name))
        })
        .collect();
    slide_paths.sort_by_key(|(num, _)| *num);

    if slide_paths.is_empty() {
        return Err(AppError::new("INVALID_PPTX", "PPTX 缺少幻灯片内容"));
    }

    let mut segments = Vec::new();
    for (num, path) in slide_paths {
        if let Some(xml) = read_zip_text(&mut archive, &path, &mut budget, "INVALID_PPTX")? {
            let lines = extract_pptx_xml_paragraphs(&xml)?;
            if !lines.is_empty() {
                segments.push(ParsedSegment {
                    locator: format!("第 {num} 页幻灯片"),
                    text: lines.join("\n"),
                });
            }
        }
        let notes_path = format!("ppt/notesSlides/notesSlide{num}.xml");
        if let Some(notes_xml) =
            read_zip_text(&mut archive, &notes_path, &mut budget, "INVALID_PPTX")?
        {
            let note_lines: Vec<String> = extract_pptx_xml_paragraphs(&notes_xml)?
                .into_iter()
                .filter(|line| line.trim() != num.to_string())
                .collect();
            if !note_lines.is_empty() {
                segments.push(ParsedSegment {
                    locator: format!("第 {num} 页演讲备注"),
                    text: note_lines.join("\n"),
                });
            }
        }
    }
    Ok(segments)
}

fn parse_eml(bytes: &[u8]) -> Result<Vec<ParsedSegment>> {
    let raw = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("ENCODING", "EML 邮件仅支持 UTF-8 文本格式"))?;
    let normalized = raw.replace("\r\n", "\n");
    let (header_block, body_block) = match normalized.split_once("\n\n") {
        Some((h, b)) => (h, b),
        None => ("", normalized.as_str()),
    };

    let mut headers = Vec::new();
    for line in header_block.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("subject:")
            || lower.starts_with("from:")
            || lower.starts_with("to:")
            || lower.starts_with("date:")
        {
            headers.push(line.trim().to_owned());
        }
    }

    let mut segments = Vec::new();
    if !headers.is_empty() {
        segments.push(ParsedSegment {
            locator: "邮件头".to_owned(),
            text: headers.join("\n"),
        });
    }

    let mut para = Vec::new();
    let mut para_idx = 0usize;
    let mut skip_encoded_part = false;
    for line in body_block.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        if trimmed.starts_with("--") && trimmed.len() > 8 && !trimmed.contains(' ') {
            skip_encoded_part = false;
            if !para.is_empty() {
                para_idx += 1;
                segments.push(ParsedSegment {
                    locator: format!("正文 第 {para_idx} 段"),
                    text: para.join("\n"),
                });
                para.clear();
            }
            continue;
        }
        if lower.starts_with("content-transfer-encoding:") && lower.contains("base64") {
            skip_encoded_part = true;
            continue;
        }
        if lower.starts_with("content-type:")
            || lower.starts_with("content-disposition:")
            || lower.starts_with("content-transfer-encoding:")
        {
            continue;
        }
        if skip_encoded_part {
            continue;
        }
        if trimmed.is_empty() {
            if !para.is_empty() {
                para_idx += 1;
                segments.push(ParsedSegment {
                    locator: format!("正文 第 {para_idx} 段"),
                    text: para.join("\n"),
                });
                para.clear();
            }
        } else {
            para.push(trimmed.to_owned());
        }
    }
    if !para.is_empty() {
        para_idx += 1;
        segments.push(ParsedSegment {
            locator: format!("正文 第 {para_idx} 段"),
            text: para.join("\n"),
        });
    }
    Ok(segments)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};

    #[test]
    fn parses_csv_with_bom_and_quoted_commas() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wbs.csv");
        let csv = "\u{feff}任务,负责人,备注\n\"接口联调, 一期\",王磊,\"含\"\"沙箱\"\"账号\"\n";
        fs::write(&path, csv).unwrap();
        let segments = parse_file(&path, "csv").unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].locator, "第 2 行");
        assert!(segments[0].text.contains("任务: 接口联调, 一期"));
        assert!(segments[0].text.contains("负责人: 王磊"));
        assert!(segments[0].text.contains("含\"沙箱\"账号"));
    }

    #[test]
    fn parses_xlsx_workbook_with_shared_strings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plan.xlsx");
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut buf);
            let opts = SimpleFileOptions::default();
            zip.start_file("xl/sharedStrings.xml", opts).unwrap();
            zip.write_all(r#"<sst><si><t>模块</t></si><si><t>负责人</t></si><si><t>工单系统</t></si><si><t>林晨</t></si></sst>"#.as_bytes()).unwrap();
            zip.start_file("xl/workbook.xml", opts).unwrap();
            zip.write_all(r#"<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="排期表" sheetId="1" r:id="rId1"/></sheets></workbook>"#.as_bytes()).unwrap();
            zip.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
            zip.write_all(br#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#).unwrap();
            zip.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
            zip.write_all(br#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>80</v></c></row></sheetData></worksheet>"#).unwrap();
            zip.finish().unwrap();
        }
        fs::write(&path, buf.into_inner()).unwrap();
        let segments = parse_file(&path, "xlsx").unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].locator, "工作表「排期表」 / 第 2 行");
        assert!(segments[0].text.contains("模块: 工单系统"));
        assert!(segments[0].text.contains("负责人: 林晨"));
        assert!(segments[0].text.contains("80"));
    }

    #[test]
    fn parses_pptx_slides_and_notes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("review.pptx");
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut buf);
            let opts = SimpleFileOptions::default();
            zip.start_file("ppt/slides/slide1.xml", opts).unwrap();
            zip.write_all(r#"<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>季度交付汇报</a:t></a:r></a:p><a:p><a:r><a:t>本周五完成灰度</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#.as_bytes()).unwrap();
            zip.start_file("ppt/notesSlides/notesSlide1.xml", opts)
                .unwrap();
            zip.write_all(r#"<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>需重点提醒运维准备账号</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>"#.as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        fs::write(&path, buf.into_inner()).unwrap();
        let segments = parse_file(&path, "pptx").unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].locator, "第 1 页幻灯片");
        assert!(segments[0].text.contains("季度交付汇报"));
        assert_eq!(segments[1].locator, "第 1 页演讲备注");
        assert!(segments[1].text.contains("运维准备账号"));
    }

    #[test]
    fn parses_eml_headers_and_body() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notice.eml");
        let eml = "From: pm@example.com\nTo: team@example.com\nSubject: 上线确认\n\n各位，测试环境本周四冻结。\n\n请周五上午前完成验收。\n";
        fs::write(&path, eml).unwrap();
        let segments = parse_file(&path, "eml").unwrap();
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0].locator, "邮件头");
        assert!(segments[0].text.contains("Subject: 上线确认"));
        assert_eq!(segments[1].locator, "正文 第 1 段");
        assert!(segments[2].text.contains("周五上午前完成验收"));
    }
}
