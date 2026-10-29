use crate::{AppError, Result};
use quick_xml::{events::Event, Reader};
use std::{
    fs,
    io::{Cursor, Read},
    path::Path,
};

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
        _ => {
            return Err(AppError::new(
                "UNSUPPORTED_FILE",
                "支持 TXT、MD、DOCX 和文本 PDF",
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

fn parse_docx(bytes: &[u8]) -> Result<Vec<ParsedSegment>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    let mut document = archive
        .by_name("word/document.xml")
        .map_err(|_| AppError::new("INVALID_DOCX", "DOCX 缺少正文"))?;
    if document.size() > 30 * 1024 * 1024 {
        return Err(AppError::new("DOCUMENT_LIMIT", "DOCX 解压后正文过大"));
    }
    let mut xml = String::new();
    document.read_to_string(&mut xml)?;
    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(false);
    let mut segments = Vec::new();
    let (mut text, mut paragraph, mut table, mut row, mut in_table, mut in_text) =
        (String::new(), 0, 0, 0, 0, false);
    let mut heading = false;
    loop {
        match reader
            .read_event()
            .map_err(|e| AppError::new("INVALID_DOCX", e.to_string()))?
        {
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
            Event::Text(e) if in_text => {
                let decoded = e
                    .decode()
                    .map_err(|e| AppError::new("INVALID_DOCX", e.to_string()))?;
                let unescaped = quick_xml::escape::unescape(&decoded)
                    .map_err(|e| AppError::new("INVALID_DOCX", e.to_string()))?;
                text.push_str(&unescaped);
            }
            Event::GeneralRef(e) if in_text => {
                let name = e
                    .decode()
                    .map_err(|e| AppError::new("INVALID_DOCX", e.to_string()))?;
                let escaped = format!("&{name};");
                let unescaped = quick_xml::escape::unescape(&escaped)
                    .map_err(|e| AppError::new("INVALID_DOCX", e.to_string()))?;
                text.push_str(&unescaped);
            }
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
    let pages = pdf_extract::extract_text_from_mem_by_pages(bytes)
        .map_err(|e| AppError::new("INVALID_PDF", format!("PDF 文字提取失败：{e}")))?;
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
