//! Local lexical retrieval shared by connector replies and the desktop assistant.
//! No project text leaves the device during ranking or excerpt selection.
use crate::{AppError, Result};
use rusqlite::{functions::FunctionFlags, Connection};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

const ALIASES: &[&[&str]] = &[
    &["登录", "登陆", "login", "signin"],
    &["审计", "audit"],
    &["备份", "backup"],
    &["数据库", "database"],
    &["接口", "api"],
    &["验收", "acceptance"],
    &["回滚", "rollback"],
    &["部署", "deploy", "deployment"],
    &["保留", "留存", "retention", "retain", "retains", "retained"],
    &["连接池", "connection pool"],
    &["最大容量", "最大数量", "maximum size", "max size"],
    &["离线", "没网", "无网络", "offline"],
    &["移动端", "手机", "mobile"],
    &["编辑", "修改", "edit", "editing"],
    &["密码", "口令", "password"],
    &["输错", "填错", "输入错误"],
    &["故障", "服务中断", "宕机", "outage", "incident"],
    &["根因", "原因", "root cause"],
    &["批量", "一次性", "batch", "bulk"],
    &["导出", "export"],
];

fn cjk(c: char) -> bool {
    matches!(c, '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}')
}

fn folded(c: char) -> char {
    match c {
        '\u{ff01}'..='\u{ff5e}' => char::from_u32(c as u32 - 0xfee0).unwrap(),
        '\u{3000}' => ' ',
        _ => c,
    }
}

fn normalize(text: &str) -> String {
    text.chars()
        .flat_map(|c| folded(c).to_lowercase())
        .collect()
}

fn word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

// Small, deterministic English morphology expansion. It is a recall signal,
// not a rewritten fact: exact spellings still receive more weight, and the
// original text is always returned to the answer contract.
fn english_stem(token: &str) -> String {
    if token == "corpora" {
        return "corpus".to_owned();
    }
    if token.len() < 4 || !token.bytes().all(|b| b.is_ascii_alphabetic()) {
        return token.to_owned();
    }
    let mut stem = token.to_owned();
    if stem.ends_with("sses") {
        stem.truncate(stem.len() - 2);
    } else if stem.ends_with("ies") && stem.len() > 4 {
        stem.truncate(stem.len() - 3);
        stem.push('y');
    } else if stem.ends_with('s')
        && !stem.ends_with("ss")
        && !stem.ends_with("us")
        && !stem.ends_with("is")
    {
        stem.pop();
    }
    for suffix in ["ingly", "edly", "ing", "ed"] {
        if let Some(root) = stem.strip_suffix(suffix) {
            if root.len() >= 3 && root.bytes().any(|c| b"aeiouy".contains(&c)) {
                stem = root.to_owned();
                break;
            }
        }
    }
    for (suffix, replacement) in [
        ("ization", "ize"),
        ("ational", "ate"),
        ("fulness", "ful"),
        ("ousness", "ous"),
        ("iveness", "ive"),
        ("tional", "tion"),
        ("biliti", "ble"),
        ("icate", "ic"),
        ("alize", "al"),
        ("iciti", "ic"),
        ("ical", "ic"),
        ("ness", ""),
    ] {
        if let Some(root) = stem.strip_suffix(suffix) {
            if root.len() >= 3 {
                stem = format!("{root}{replacement}");
                break;
            }
        }
    }
    if stem.len() >= 6 && stem.ends_with("er") {
        stem.truncate(stem.len() - 2);
    }
    if stem.len() >= 4 && stem.ends_with('e') {
        stem.pop();
    }
    if stem.len() >= 4 && stem.ends_with('y') {
        stem.pop();
        stem.push('i');
    }
    let bytes = stem.as_bytes();
    if bytes.len() >= 4
        && bytes[bytes.len() - 1] == bytes[bytes.len() - 2]
        && b"bdgmnprt".contains(&bytes[bytes.len() - 1])
    {
        stem.pop();
    }
    stem
}

struct SearchText {
    text: String,
    stems: BTreeMap<String, usize>,
}

impl SearchText {
    fn new(text: &str) -> Self {
        let text = normalize(text);
        let mut stems = BTreeMap::new();
        for token in text.split(|c: char| !word(c) || cjk(c)) {
            if token.len() >= 3 && token.bytes().all(|b| b.is_ascii_alphabetic()) {
                *stems.entry(english_stem(token)).or_default() += 1;
            }
        }
        Self { text, stems }
    }

    fn frequency(&self, term: &str) -> f64 {
        let exact = occurrences(&self.text, term).count();
        let related = if term.len() >= 3 && term.bytes().all(|b| b.is_ascii_alphabetic()) {
            self.stems.get(&english_stem(term)).copied().unwrap_or(0)
        } else {
            exact
        };
        exact as f64 + related.saturating_sub(exact) as f64 * 0.7
    }
}

fn english_stopword(run: &str) -> bool {
    matches!(
        run,
        "a" | "the"
            | "is"
            | "are"
            | "was"
            | "were"
            | "be"
            | "been"
            | "being"
            | "what"
            | "when"
            | "who"
            | "whom"
            | "whose"
            | "which"
            | "where"
            | "how"
            | "why"
            | "please"
            | "project"
            | "task"
            | "does"
            | "do"
            | "did"
            | "of"
            | "to"
            | "and"
            | "or"
            | "for"
            | "in"
            | "on"
            | "at"
            | "by"
            | "from"
            | "with"
            | "without"
            | "about"
            | "into"
            | "as"
            | "an"
            | "my"
            | "our"
            | "your"
            | "their"
            | "his"
            | "her"
            | "its"
            | "we"
            | "they"
            | "them"
            | "he"
            | "she"
            | "it"
            | "this"
            | "that"
            | "these"
            | "those"
            | "there"
            | "here"
            | "has"
            | "have"
            | "had"
            | "can"
            | "could"
            | "would"
            | "should"
            | "will"
            | "may"
            | "might"
            | "must"
            | "also"
            | "status"
            | "progress"
            | "due"
    )
}

/// Facets such as "we" and "the model" are grammatical subjects, not names
/// that can restrict every other memory's applicability. This classification
/// never adds a scope or modifies a stored annotation.
pub(crate) fn specific_entity(entity: &str) -> bool {
    let entity = normalize(entity);
    if entity.chars().any(cjk) {
        return !matches!(
            entity.as_str(),
            "我们"
                | "他们"
                | "作者"
                | "本项目"
                | "该项目"
                | "这个项目"
                | "模型"
                | "本模型"
                | "该模型"
                | "系统"
                | "本系统"
                | "该系统"
                | "方法"
                | "本方法"
                | "该方法"
                | "数据"
                | "数据集"
                | "训练数据"
                | "本数据集"
                | "该数据集"
                | "语料"
                | "本研究"
                | "该研究"
        );
    }
    entity.split(|c: char| !word(c)).any(|token| {
        !token.is_empty()
            && !english_stopword(token)
            && !matches!(
                token,
                "model"
                    | "models"
                    | "system"
                    | "systems"
                    | "method"
                    | "methods"
                    | "approach"
                    | "approaches"
                    | "author"
                    | "authors"
                    | "paper"
                    | "study"
                    | "research"
                    | "algorithm"
                    | "algorithms"
                    | "network"
                    | "networks"
                    | "data"
                    | "dataset"
                    | "datasets"
                    | "experiment"
                    | "experiments"
                    | "result"
                    | "results"
                    | "input"
                    | "inputs"
                    | "output"
                    | "outputs"
                    | "proposed"
                    | "present"
                    | "current"
                    | "new"
                    | "existing"
                    | "individual"
                    | "main"
                    | "general"
                    | "first"
                    | "second"
                    | "third"
                    | "following"
            )
    })
}

/// Navigation cues describe how a stored sentence is written, not what task a
/// document or model actually performs. They never override entity eligibility
/// and are not accepted as semantic evidence by the answer contract.
pub(crate) fn data_provenance(text: &str) -> bool {
    let original = text;
    let text = SearchText::new(text);
    if prospective_or_other_work(&text.text) {
        return false;
    }
    let collected = [
        "collect", "obtain", "gather", "download", "acquire", "sample", "retrieve", "source",
        "采集", "收集", "获取", "下载", "抽取", "抓取",
    ]
    .iter()
    .any(|term| text.frequency(term) > 0.0);
    let transform = [
        "feature",
        "embedding",
        "vector",
        "representation",
        "token",
        "特征",
        "向量",
        "表示",
    ]
    .iter()
    .any(|term| text.frequency(term) > 0.0);
    let derived_output = [
        "score",
        "feature",
        "embedding",
        "vector",
        "representation",
        "分数",
        "特征",
        "向量",
        "表示",
    ]
    .iter()
    .any(|term| text.frequency(term) > 0.0)
        && [
            "compute",
            "calculate",
            "derive",
            "encode",
            "extract",
            "transform",
            "计算",
            "编码",
            "提取",
            "转换",
        ]
        .iter()
        .any(|term| text.frequency(term) > 0.0);
    if derived_output {
        return false;
    }
    let extracted = text.frequency("extract") > 0.0 && !transform;
    let data_terms = [
        "data",
        "dataset",
        "corpus",
        "example",
        "sample",
        "record",
        "document",
        "observation",
        "sentence",
        "review",
        "benchmark",
        "bitext",
        "数据",
        "语料",
        "样本",
        "记录",
        "文档",
    ];
    let has_data = |value: &SearchText| data_terms.iter().any(|term| value.frequency(term) > 0.0);
    let data = has_data(&text);
    let origin = ["from", "via", "来自", "来源", "通过", "采自", "取自", "从"]
        .iter()
        .filter_map(|term| occurrences(&text.text, term).next())
        .min();
    // A source phrase must describe the acquired data, not improvements or
    // model variables obtained from it. Look before the first origin marker so
    // a later inference sentence does not erase an earlier collection fact.
    let head = SearchText::new(origin.map_or(text.text.as_str(), |at| &text.text[..at]));
    let inference_output = [
        "role",
        "label",
        "parameter",
        "latent",
        "hidden",
        "clv",
        "posterior",
        "角色",
        "标签",
        "参数",
        "潜变量",
        "隐变量",
        "后验",
    ]
    .iter()
    .any(|term| head.frequency(term) > 0.0)
        && [
            "sample", "generate", "infer", "estimate", "clamp", "induce", "采样", "生成", "推断",
            "估计", "固定",
        ]
        .iter()
        .any(|term| head.frequency(term) > 0.0);
    if inference_output {
        return false;
    }
    let outcome = [
        "improvement",
        "gain",
        "score",
        "accuracy",
        "performance",
        "loss",
        "改进",
        "提升",
        "分数",
        "准确率",
        "性能",
        "损失",
    ]
    .iter()
    .any(|term| head.frequency(term) > 0.0);
    let quantity = text.text.chars().any(char::is_numeric);
    let uses_resource = [
        "we use",
        "we used",
        "we utilise",
        "we utilised",
        "we utilize",
        "we utilized",
        "we employ",
        "we employed",
        "we adopt",
        "we adopted",
        "we train",
        "we evaluate",
        "trained on",
        "training on",
        "train on",
        "trained using",
        "trained with",
        "我们使用",
        "我们采用",
        "使用语料",
        "使用数据",
        "训练语料",
        "训练数据",
    ]
    .iter()
    .any(|term| occurrences(&text.text, term).next().is_some());
    let named_resource = original
        .split(|c: char| !word(c))
        .filter(|token| !token.is_empty())
        .enumerate()
        .any(|(position, token)| {
            position > 0
                && token.chars().next().is_some_and(char::is_uppercase)
                && specific_entity(token)
                && !matches!(
                    normalize(token).as_str(),
                    "corpus" | "training" | "another" | "sentence" | "sentences"
                )
        });
    let experiment_resource = ["run", "ran", "conduct", "conducted", "perform", "performed"]
        .iter()
        .any(|verb| {
            [
                "experiments on",
                "our experiments on",
                "experiments using",
                "our experiments using",
            ]
            .iter()
            .any(|object| {
                occurrences(&text.text, &format!("we {verb} {object}"))
                    .next()
                    .is_some()
            })
        });
    let identified_resource = named_resource
        || [
            "public",
            "released",
            "published",
            "provided",
            "available",
            "公开",
            "发布",
            "提供",
        ]
        .iter()
        .any(|term| occurrences(&text.text, term).next().is_some());
    (origin.is_some()
        && (has_data(&head)
            || (extracted && data)
            || ((collected || extracted) && quantity && !outcome)))
        || (data && uses_resource && identified_resource)
        || (data && experiment_resource && named_resource)
}

pub(crate) fn study_context(text: &str) -> bool {
    let text = normalize(text);
    !prospective_or_other_work(&text)
        && [
            "in this paper",
            "in this work",
            "in this study",
            "our work",
            "we propose",
            "we present",
            "we investigate",
            "we evaluate",
            "this paper presents",
            "this study",
            "本文",
            "本研究",
            "本工作",
            "我们提出",
            "我们研究",
            "我们的工作",
        ]
        .iter()
        .any(|term| occurrences(&text, term).next().is_some())
}

fn prospective_or_other_work(text: &str) -> bool {
    if ["section ", "in section ", "chapter ", "in chapter "]
        .iter()
        .any(|prefix| text.trim_start().starts_with(prefix))
        || (text.trim_start().starts_with('第')
            && text.chars().take(12).any(|c| matches!(c, '章' | '节')))
    {
        return true;
    }
    [
        "in future",
        "in the future",
        "future work",
        "we plan",
        "we will",
        "we intend",
        "previous work",
        "prior work",
        "earlier studies",
        "they used",
        "they collected",
        "their study",
        "their work",
        "can be extended",
        "could be extended",
        "can be included",
        "can also be included",
        "could be included",
        "未来",
        "计划",
        "后续工作",
        "以往研究",
        "先前研究",
    ]
    .iter()
    .any(|term| occurrences(text, term).next().is_some())
}

fn occurrences<'a>(text: &'a str, term: &'a str) -> impl Iterator<Item = usize> + 'a {
    text.match_indices(term)
        .filter_map(move |(offset, matched)| {
            let end = offset + matched.len();
            (term.chars().any(cjk)
                || (!text[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(|c| word(c) && !cjk(c))
                    && !text[end..]
                        .chars()
                        .next()
                        .is_some_and(|c| word(c) && !cjk(c))))
            .then_some(offset)
        })
}

#[derive(Clone)]
pub(crate) struct Query {
    original: String,
    terms: BTreeMap<String, f64>,
    concepts: Vec<Vec<String>>,
    rewrites: Vec<Query>,
}

impl Query {
    /// Index candidates are a superset of lexical matches; BM25 still decides
    /// their order. Every query term contributes a searchable word or bigram.
    pub(crate) fn index_expression(&self) -> String {
        let mut tokens = std::collections::BTreeSet::new();
        for term in self.terms.keys() {
            let indexed = index_tokens(term);
            if !term.chars().any(cjk) {
                tokens.extend(indexed);
            } else if let Some(token) = indexed
                .iter()
                .find(|s| s.chars().count() >= 2)
                .or_else(|| indexed.iter().next())
                .cloned()
            {
                tokens.insert(token);
            }
        }
        for rewrite in &self.rewrites {
            let expression = rewrite.index_expression();
            if !expression.is_empty() {
                tokens.insert(format!("({expression})"));
            }
        }
        tokens
            .into_iter()
            .map(|s| {
                if s.starts_with('(') {
                    s
                } else {
                    format!("\"{s}\"")
                }
            })
            .collect::<Vec<_>>()
            .join(" OR ")
    }
    pub(crate) fn new(question: &str) -> Self {
        let original = normalize(question);
        let mut cleaned = original.clone();
        // Spaces preserve boundaries instead of joining words across removed text.
        for stop in [
            "请告诉我",
            "什么时候",
            "请帮我",
            "告诉我",
            "怎么样",
            "是什么",
            "能不能",
            "有没有",
            "负责人",
            "为什么",
            "请问",
            "帮我",
            "一下",
            "我们",
            "这个",
            "那个",
            "目前",
            "现在",
            "项目",
            "任务",
            "整体",
            "进展",
            "进度",
            "状态",
            "情况",
            "总览",
            "概览",
            "今天",
            "本周",
            "这周",
            "什么",
            "怎么",
            "如何",
            "是否",
            "可以",
            "能否",
            "知道",
            "想问",
            "多少",
            "多久",
            "哪里",
            "哪些",
            "负责",
            "时间",
            "日期",
            "你好",
            "谁",
            "吗",
            "呢",
            "的",
            "了",
            "啊",
            "呀",
            "是",
        ] {
            cleaned = cleaned.replace(stop, " ");
        }
        let mut query = Self {
            original,
            terms: BTreeMap::new(),
            concepts: Vec::new(),
            rewrites: Vec::new(),
        };
        // Treat a known concept as one unit rather than giving its overlapping
        // Chinese n-grams more votes than an equivalent English expression.
        let mut tokens = cleaned.clone();
        for aliases in ALIASES {
            let matched: Vec<_> = aliases
                .iter()
                .filter(|alias| occurrences(&cleaned, alias).next().is_some())
                .collect();
            if !matched.is_empty() {
                query
                    .concepts
                    .push(aliases.iter().map(|alias| (*alias).to_owned()).collect());
                for alias in *aliases {
                    query.terms.insert(
                        (*alias).to_owned(),
                        if matched.contains(&alias) { 2.0 } else { 0.6 },
                    );
                }
                for alias in matched {
                    // Replace from the end so byte offsets stay valid.
                    for offset in occurrences(&tokens, alias)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                    {
                        tokens.replace_range(offset..offset + alias.len(), " ");
                    }
                }
            }
        }
        let mut run = String::new();
        let mut chinese = false;
        for c in tokens.chars().chain(std::iter::once(' ')) {
            if !word(c) || (!run.is_empty() && chinese != cjk(c)) {
                query.add_run(&run, chinese);
                run.clear();
            }
            if word(c) {
                chinese = cjk(c);
                run.push(c);
            }
        }
        query
    }

    /// Rewrites are search strings only. They cannot change scope, question,
    /// visibility, versions, or the facts available to an answer.
    pub(crate) fn from_payload(payload: &Value) -> Result<Self> {
        let mut query = Self::new(payload["question"].as_str().unwrap_or(""));
        if let Some(values) = payload.get("searchQueries") {
            let values = values
                .as_array()
                .ok_or_else(|| AppError::new("SEARCH_PLAN", "检索改写必须为字符串数组"))?;
            if values.len() > 3 {
                return Err(AppError::new("SEARCH_PLAN", "每次最多补充3个检索词组"));
            }
            for value in values {
                let text = value
                    .as_str()
                    .ok_or_else(|| AppError::new("SEARCH_PLAN", "检索词组格式无效"))?;
                if text.trim().chars().count() < 2 || text.chars().count() > 160 {
                    return Err(AppError::new("SEARCH_PLAN", "检索词组长度无效"));
                }
                query.rewrites.push(Self::new(text));
            }
        }
        Ok(query)
    }

    pub(crate) fn overview(&self) -> bool {
        [
            "总览",
            "概览",
            "简报",
            "本周状态",
            "本周进展",
            "这周进展",
            "项目怎么样",
            "项目进展",
            "最近决策",
            "哪些决策",
        ]
        .iter()
        .any(|term| self.original.contains(term))
    }

    pub(crate) fn names(&self, title: &str) -> bool {
        let title = normalize(title);
        title.chars().count() >= 2 && occurrences(&self.original, &title).next().is_some()
    }

    pub(crate) fn names_entity(&self, entity: &str) -> bool {
        let entity = normalize(entity);
        specific_entity(&entity)
            && !entity.is_empty()
            && occurrences(&self.original, &entity).next().is_some()
    }

    /// Broad data questions need data-source and study context as alternatives
    /// to repeatedly matching a component's "training/model" wording. Explicit
    /// component questions keep their intended target and do not use this path.
    pub(crate) fn navigates_data_context(&self) -> bool {
        let original = SearchText::new(&self.original);
        let data = ["data", "dataset", "corpus", "数据", "语料"]
            .iter()
            .any(|term| original.frequency(term) > 0.0);
        let component = [
            "component",
            "module",
            "submodel",
            "subtask",
            "sub-model",
            "sub-task",
            "encoder",
            "decoder",
            "classifier",
            "embedding",
            "embeddings",
            "baseline",
            "auxiliary",
            "pretraining",
            "pre-training",
            "组件",
            "模块",
            "子模型",
            "子任务",
            "编码器",
            "解码器",
            "分类器",
            "基线",
            "辅助",
            "预训练",
        ]
        .iter()
        .any(|term| occurrences(&self.original, term).next().is_some());
        data && !component
    }

    fn field_bonus(&self, body: &str) -> f64 {
        let body = normalize(body);
        let owner = ["谁", "负责人", "负责", "owner", "assignee"]
            .iter()
            .any(|term| self.original.contains(term));
        let deadline = ["截止", "哪天", "日期", "deadline", "due date"]
            .iter()
            .any(|term| self.original.contains(term));
        if owner
            && ["负责", "联系人", "对接人", "owner", "assignee"]
                .iter()
                .any(|term| body.contains(term))
        {
            1.8
        } else if deadline
            && ["截止", "日期", "deadline", "due date"]
                .iter()
                .any(|term| body.contains(term))
        {
            1.5
        } else {
            1.0
        }
    }

    fn add_run(&mut self, run: &str, chinese: bool) {
        if run.is_empty() || self.terms.len() >= 256 {
            return;
        }
        if chinese {
            let chars: Vec<_> = run.chars().collect();
            for (width, weight) in [(2, 1.0), (3, 1.5)] {
                for part in chars.windows(width).take(128) {
                    self.terms.insert(part.iter().collect(), weight);
                }
            }
            if (2..=16).contains(&chars.len()) {
                self.terms.insert(run.to_owned(), 2.0);
                self.concepts.push(vec![run.to_owned()]);
            }
        } else if run.len() > 1 && !english_stopword(run) {
            self.terms.insert(run.to_owned(), 3.0);
            self.concepts.push(vec![run.to_owned()]);
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.terms.is_empty() && self.rewrites.iter().all(Query::is_empty)
    }

    fn coverage(&self, title: &str, body: &str) -> f64 {
        if self.concepts.is_empty() {
            return 1.0;
        }
        let title = SearchText::new(title);
        let body = SearchText::new(body);
        let matched = self
            .concepts
            .iter()
            .filter(|aliases| {
                aliases
                    .iter()
                    .any(|term| title.frequency(term) > 0.0 || body.frequency(term) > 0.0)
            })
            .count();
        matched as f64 / self.concepts.len() as f64
    }

    /// Saturating term frequency and a length penalty prevent repeated generic
    /// words from outweighing specific names. Titles receive a bounded boost.
    pub(crate) fn score(&self, title: &str, body: &str) -> usize {
        let title = normalize(title);
        let body = normalize(body);
        let field = |text: &str| {
            let text = SearchText::new(text);
            let norm = 1.0 + text.text.chars().count().min(1200) as f64 / 1200.0;
            self.terms
                .iter()
                .map(|(term, weight)| {
                    let tf = text.frequency(term).min(12.0);
                    weight * tf * 2.2 / (tf + 1.2 * norm)
                })
                .sum::<f64>()
        };
        let exact_title = title.chars().count() >= 2 && self.original.contains(&title);
        let base = field(&title) * 3.0 + field(&body);
        let coverage = self.coverage(&title, &body).powi(2);
        let score = if base > 0.0 {
            base * (0.25 + 0.75 * coverage) * 100.0 + coverage * 1000.0
        } else {
            0.0
        };
        let primary =
            (score * self.field_bonus(&body)) as usize + usize::from(exact_title) * 100_000;
        self.rewrites
            .iter()
            .map(|q| q.score(&title, &body) * 4 / 5)
            .fold(primary, usize::max)
    }

    /// BM25 over the scoped corpus gives rare names more weight than words that
    /// occur in almost every memory. Stable record IDs break ties at the caller.
    pub(crate) fn rank(&self, documents: &[&str]) -> Vec<f64> {
        let texts: Vec<_> = documents.iter().map(|text| SearchText::new(text)).collect();
        let average = (texts
            .iter()
            .map(|text| text.text.chars().count())
            .sum::<usize>() as f64
            / texts.len().max(1) as f64)
            .max(1.0);
        let mut scores = vec![0.0; texts.len()];
        for (term, weight) in &self.terms {
            let frequencies: Vec<_> = texts.iter().map(|text| text.frequency(term)).collect();
            let df = frequencies.iter().filter(|tf| **tf > 0.0).count() as f64;
            let idf = (1.0 + (texts.len() as f64 - df + 0.5) / (df + 0.5)).ln();
            for (index, (text, tf)) in texts.iter().zip(frequencies).enumerate() {
                let length = text.text.chars().count() as f64;
                scores[index] +=
                    weight * idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length / average));
            }
        }
        for (index, text) in texts.iter().enumerate() {
            scores[index] *= 0.25 + 0.75 * self.coverage("", &text.text).powi(2);
            scores[index] *= self.field_bonus(&text.text);
        }
        for rewrite in &self.rewrites {
            for (score, alternate) in scores.iter_mut().zip(rewrite.rank(documents)) {
                *score = score.max(alternate * 0.8);
            }
        }
        scores
    }

    /// Pick the window covering the most distinct query terms, retaining exact
    /// original characters so evidence and snapshot validation remain valid.
    pub(crate) fn excerpt(&self, text: &str, limit: usize) -> String {
        let chars: Vec<_> = text.chars().collect();
        if chars.len() <= limit || limit == 0 {
            return chars.into_iter().take(limit).collect();
        }
        let mut normalized = String::new();
        let mut offsets = Vec::new();
        for (index, c) in chars.iter().enumerate() {
            for lower in folded(*c).to_lowercase() {
                offsets.push((normalized.len(), index));
                normalized.push(lower);
            }
        }
        let mut combined_terms = self.terms.clone();
        for rewrite in &self.rewrites {
            for (term, weight) in &rewrite.terms {
                combined_terms.entry(term.clone()).or_insert(*weight * 0.8);
            }
        }
        let mut stem_weights = BTreeMap::<String, f64>::new();
        for (term, weight) in &combined_terms {
            if term.len() >= 3 && term.bytes().all(|b| b.is_ascii_alphabetic()) {
                let value = stem_weights.entry(english_stem(term)).or_default();
                *value = value.max(*weight * 0.7);
            }
        }
        for token in normalized.split(|c: char| !word(c) || cjk(c)) {
            if let Some(weight) = stem_weights.get(&english_stem(token)) {
                combined_terms.entry(token.to_owned()).or_insert(*weight);
            }
        }
        let mut hits = Vec::new();
        for (term_index, (term, _)) in combined_terms.iter().enumerate() {
            for offset in occurrences(&normalized, term).take(128) {
                let index = offsets.partition_point(|(byte, _)| *byte <= offset) - 1;
                hits.push((offsets[index].1, term_index));
            }
        }
        hits.sort_unstable();
        let weights: Vec<_> = combined_terms.values().copied().collect();
        let mut counts = vec![0; weights.len()];
        let (mut left, mut score, mut best, mut start) = (0, 0.0, 0.0, 0);
        for right in 0..hits.len() {
            let term = hits[right].1;
            if counts[term] == 0 {
                score += weights[term];
            }
            counts[term] += 1;
            while hits[right].0 - hits[left].0 >= (limit * 3 / 4).max(1) {
                let term = hits[left].1;
                counts[term] -= 1;
                if counts[term] == 0 {
                    score -= weights[term];
                }
                left += 1;
            }
            if score > best {
                best = score;
                start = hits[left]
                    .0
                    .saturating_sub(limit / 8)
                    .min(chars.len() - limit);
            }
        }
        chars[start..start + limit].iter().collect()
    }
}

pub(crate) fn index_tokens(text: &str) -> std::collections::BTreeSet<String> {
    let mut tokens = std::collections::BTreeSet::new();
    let mut run = String::new();
    let mut chinese = false;
    for c in normalize(text).chars().chain(std::iter::once(' ')) {
        if !word(c) || (!run.is_empty() && chinese != cjk(c)) {
            if chinese {
                let chars = run.chars().collect::<Vec<_>>();
                for pair in chars.windows(2) {
                    tokens.insert(pair.iter().collect());
                }
                // Single-character entity queries remain discoverable.
                for c in chars {
                    tokens.insert(c.to_string());
                }
            } else if !run.is_empty() {
                tokens.insert(run.clone());
                tokens.insert(english_stem(&run));
            }
            run.clear();
        }
        if word(c) {
            chinese = cjk(c);
            run.push(c);
        }
    }
    tokens
}

/// Register on the database actor's connection before preparing retrieval SQL.
/// Query text stays captured data, never executable SQL. The same scorer runs
/// before LIMIT and in the final desktop reference ranking.
pub(crate) fn register(conn: &Connection, payload: &Value) -> Result<()> {
    let query = Arc::new(Query::from_payload(payload)?);
    let scorer = query.clone();
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    conn.create_scalar_function("project_search_score", 2, flags, move |ctx| {
        Ok(scorer.score(ctx.get_raw(0).as_str()?, ctx.get_raw(1).as_str()?) as i64)
    })?;
    conn.create_scalar_function("project_search_excerpt", 2, flags, move |ctx| {
        let limit = ctx.get::<usize>(1)?.min(4_000);
        Ok(query.excerpt(ctx.get_raw(0).as_str()?, limit))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_plan_is_bounded_and_literal_search_never_changes_scope() {
        for values in [
            serde_json::json!(null),
            serde_json::json!([1]),
            serde_json::json!(["a"]),
            serde_json::json!(["aa", "bb", "cc", "dd"]),
            serde_json::json!(["长".repeat(161)]),
        ] {
            assert!(Query::from_payload(
                &serde_json::json!({"question":"设备回收","searchQueries":values})
            )
            .is_err());
        }
        let plan = Query::from_payload(
            &serde_json::json!({"question":"设备如何交还","searchQueries":["离职资产归还"]}),
        )
        .unwrap();
        assert!(plan.score("", "离职资产归还登记由综合部办理。") > 0);
        assert!(plan.names("设备"));
        assert_eq!(plan.score("", "没有相关事项"), 0);
    }

    #[test]
    fn requested_owner_field_outranks_process_text_without_matching_unrelated_owners() {
        let query = Query::new("火星验收由谁负责？");
        let docs = [
            "火星验收流程要求先完成联调。",
            "火星验收由李思负责。",
            "金星采购由陈舟负责。",
        ];
        let scores = query.rank(&docs);
        assert!(scores[1] > scores[0]);
        assert_eq!(scores[2], 0.0);
    }

    #[test]
    fn mixed_scripts_fullwidth_words_and_aliases_match_without_substring_noise() {
        let query = Query::new("请问ＡＬＰＨＡ登录审计的进展？");
        assert!(query.score("", "alpha login audit") > 0);
        assert!(query.score("", "ALPHA 登录审计") > query.score("", "登录页面"));
        assert_eq!(Query::new("API").score("", "apiary"), 0);
        assert!(Query::new("API").score("", "接口限流规则") > 0);
        assert!(Query::new("请问目前这个项目怎么样？").is_empty());
    }

    #[test]
    fn rare_subject_and_concise_answer_outrank_repeated_generic_terms() {
        let query = Query::new("雪山接口验收");
        let noisy = "接口验收，".repeat(300);
        let documents = [
            noisy.as_str(),
            "雪山接口验收由小王负责。",
            "接口验收规则已确认。",
        ];
        let scores = query.rank(&documents);
        assert!(scores[1] > scores[0] && scores[1] > scores[2]);
    }

    #[test]
    fn excerpts_prefer_dense_late_matches_and_preserve_original_unicode() {
        let text = format!(
            "接口{}İ👩🏽‍💻雪山接口验收，负责人小王。{}",
            "无关内容".repeat(800),
            "尾".repeat(100)
        );
        let excerpt = Query::new("雪山接口验收").excerpt(&text, 120);
        assert!(excerpt.contains("雪山接口验收"));
        assert!(text.contains(&excerpt));
        assert_eq!(excerpt.chars().count(), 120);
    }

    #[test]
    fn english_morphology_recalls_related_forms_with_exact_spelling_preferred() {
        let query = Query::new("Which service encodes the images?");
        let scores = query.rank(&[
            "The service encodes the images.",
            "The service encoder transforms an image.",
            "The image gallery has a descriptive title.",
        ]);
        assert!(scores[0] > scores[1] && scores[1] > scores[2]);
        assert!(Query::new("consist").score("", "A service consists of three workers.") > 0);
        assert!(Query::new("policies").score("", "The policy requires approval.") > 0);
        assert_eq!(
            Query::new("password").score("", "The passport is invalid."),
            0
        );
        assert_eq!(Query::new("Atlas").score("", "An atmospheric sensor."), 0);
        assert_eq!(
            Query::new("was there anything").score("", "There was an answer."),
            0
        );
    }

    #[test]
    fn entity_bindings_require_a_literal_name_and_ignore_generic_subjects() {
        let query =
            Query::new("Does the model use our approach? Ann and Atlas API have different owners.");
        for generic in ["the model", "we", "our approach", "authors", "this system"] {
            assert!(!query.names_entity(generic), "{generic}");
        }
        assert!(query.names_entity("Ann"));
        assert!(query.names_entity("Atlas API"));
        assert!(!Query::new("annual report").names_entity("Ann"));
        assert!(!Query::new("How does Atlas API work?").names_entity("Atlas AP"));
        assert!(Query::new("甲的负责人").names_entity("甲"));
        assert!(!Query::new("甲的负责人").names_entity("乙"));
    }

    #[test]
    fn index_and_rank_share_morphology_without_splitting_names_or_identifiers() {
        let tokens = index_tokens("Encoders encode images in Atlas2026 API_v2.");
        assert!(tokens.contains("encod"));
        assert!(tokens.contains("imag"));
        assert!(tokens.contains("atlas2026"));
        assert!(tokens.contains("api_v2"));
        let expression = Query::new("encoder images").index_expression();
        assert!(expression.contains("\"encod\""));
        assert!(expression.contains("\"imag\""));
    }

    #[test]
    fn broad_data_navigation_preserves_explicit_component_targets_in_both_languages() {
        for question in [
            "What datasets are used to train the model?",
            "Which corpus does the system use?",
            "这个模型使用什么训练数据？",
            "研究的语料来自哪里？",
        ] {
            assert!(Query::new(question).navigates_data_context(), "{question}");
        }
        for question in [
            "Which dataset trains the encoder?",
            "Which corpus was used for pre-training the baseline classifier?",
            "What data trained the embedding module?",
            "子模型的训练数据是什么？",
            "编码器使用什么语料？",
            "Who owns the model?",
        ] {
            assert!(!Query::new(question).navigates_data_context(), "{question}");
        }
    }

    #[test]
    fn corpus_plural_is_exact_morphology_without_merging_longer_names() {
        assert!(Query::new("corpora").score("", "The corpus comes from a public archive.") > 0);
        assert!(Query::new("corpus").score("", "Several corpora are available.") > 0);
        assert_eq!(
            Query::new("corpus").score("", "CorporaDB is a service name."),
            0
        );
        assert!(Query::new("Which corpora are used?").navigates_data_context());
        assert!(index_tokens("corpora").contains("corpus"));
    }

    #[test]
    fn provenance_and_study_cues_are_navigation_not_inferred_task_labels() {
        for body in [
            "We collected 48,000 observations from the municipal registry.",
            "Hourly readings from 2022 are obtained via a public archive.",
            "The corpus is sourced from an openly published repository.",
            "我们从公开档案收集了800条记录。",
            "研究数据来自城市公开平台。",
            "For evaluation, we use the Mountain Speech Corpus.",
            "We train language models on the Valley corpus comprising recorded sentences.",
            "Another model is trained on the Harbor archive comprising recorded sentences.",
            "我们使用公开语料训练模型。",
        ] {
            assert!(data_provenance(body), "{body}");
        }
        for body in [
            "Features extracted by the layer are fed into the classifier.",
            "We extract 300 embedding features from the input representation.",
            "Section 4 discusses sentiment extracted from the messages.",
            "This study can be extended by incorporating data from public news.",
            "In this paper, we predict events based on sentiments extracted from messages.",
            "We plan to collect 80,000 samples from another archive.",
            "They collected 900 documents from previous work.",
            "未来计划从公开平台获取900条数据。",
            "The collected data may be incomplete.",
            "The word polarity scores are computed from the training data.",
            "We calculate embedding features from the public corpus.",
            "We train on 48 GPUs for four days.",
            "我们从训练数据计算特征分数。",
        ] {
            assert!(!data_provenance(body), "{body}");
        }
        assert!(study_context(
            "In this study, we predict rainfall using weather observations."
        ));
        assert!(study_context("本文提出天气预测方法。"));
        assert!(!study_context(
            "Previous work used a neural system for this study."
        ));
        assert!(!study_context(
            "We plan to evaluate the proposed model in future work."
        ));
    }

    #[test]
    fn provenance_preserves_acquisition_but_not_model_outcomes_or_inference_samples() {
        for body in [
            "We collect 720 readings from the open sensor registry.",
            "Measurements from 2023 are obtained via a public archive.",
            "The dataset comes from the Regional Records Office.",
            "We sample 120 documents from the public archive.",
            "Role labels are extracted from the annotated corpus.",
            "We collected 720 observations from the registry. We then sampled hidden variables during inference.",
            "我们从公开档案收集了720条记录，再对潜变量采样。",
        ] {
            assert!(data_provenance(body), "{body}");
        }
        for body in [
            "The model obtains small improvements from the standard setup, comparing conditions 3 and 7.",
            "We obtain a higher accuracy score from the validation data.",
            "We sample role labels from the training sentences.",
            "We sampled parameters from the posterior distribution using 60 observations.",
            "Latent variables are sampled from the training data.",
            "We generate hidden variables from the data using a non-parametric process.",
            "We generate CLVs from the data using a Chinese Restaurant Process.",
            "We clamp the role labels of the supervised sentences using the mapping from section 8.",
            "我们从训练数据估计参数。",
            "我们从数据生成潜变量。",
        ] {
            assert!(!data_provenance(body), "{body}");
        }
    }

    #[test]
    fn experiment_navigation_requires_current_first_person_named_data_resource() {
        for body in [
            "We run experiments on the Cedar corpus and the River dataset.",
            "We ran our experiments on the Cedar corpus.",
            "For evaluation, we conduct experiments on the Cedar corpus.",
            "We conducted our experiments using the Cedar dataset.",
            "We perform experiments on the Cedar corpus.",
            "We performed our experiments on the Cedar benchmark.",
        ] {
            assert!(data_provenance(body), "{body}");
        }
        for body in [
            "We run experiments on several datasets.",
            "We conduct experiments on 24 GPUs.",
            "They performed experiments on the Cedar corpus.",
            "We plan to conduct experiments on the Cedar corpus.",
            "Previous work ran experiments on the Cedar corpus.",
        ] {
            assert!(!data_provenance(body), "{body}");
        }
    }
}
