//! Literal target/navigation contracts. These do not establish model identity or
//! replace current-snapshot, anchor, applicability or semantic review checks.
use crate::search::Query;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;

const VERSION: &str = "question-target-v5-member-and-cardinality-gaps";
const MAX_VIEW_CHARS: usize = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaimScope {
    CompatibleWitness,
    OtherExplicitTarget,
    Contradiction,
    Unresolved,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GapScope {
    ExplicitlyAsked,
    UnaskedDetail,
    Unresolved,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CandidateWitness {
    pub reference_id: String,
    pub gap_index: usize,
    pub reason: String,
    pub anchors: Vec<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Focus {
    Unit,
    Composite,
    Component,
    StudyIntent,
    Unspecified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Relation {
    Identity,
    Composition,
    Data,
    Training,
    Mechanism,
    Metric,
    Count,
    Shared,
    Comparison,
    Owner,
    Approval,
    Date,
    Duration,
    Calculation,
}

#[derive(Clone, Debug)]
struct Witness {
    id: String,
    role: Focus,
    relation: Relation,
    subject: String,
    literal: String,
    background: bool,
}

impl Witness {
    fn anchor(&self) -> Value {
        json!({"referenceId":self.id,"literal":self.literal})
    }
}

#[derive(Clone, Debug)]
pub(crate) struct TargetPlan {
    question: String,
    focus: Focus,
    relations: BTreeSet<Relation>,
    names: Vec<String>,
    witnesses: Vec<Witness>,
}

fn lower(value: &str) -> String {
    // ASCII case folding preserves UTF-8 byte boundaries for literal anchors.
    value.to_ascii_lowercase()
}

fn has(text: &str, term: &str) -> bool {
    let text = lower(text);
    let term = lower(term);
    text.match_indices(&term).any(|(at, _)| {
        if !term.is_ascii() {
            return true;
        }
        let word = |c: char| c.is_alphanumeric() || c == '_';
        (at == 0 || !text[..at].chars().next_back().is_some_and(word))
            && (at + term.len() == text.len()
                || !text[at + term.len()..].chars().next().is_some_and(word))
    })
}

fn any(text: &str, terms: &[&str]) -> bool {
    terms.iter().any(|term| has(text, term))
}

fn modified_model(text: &str, modifier: &str) -> bool {
    let normalized = lower(text);
    let words = normalized
        .split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    for (at, word) in words.iter().enumerate() {
        if *word != modifier {
            continue;
        }
        for next in words.iter().skip(at + 1).take(3) {
            if matches!(
                *next,
                "model" | "models" | "classifier" | "system" | "network"
            ) {
                return true;
            }
            if matches!(
                *next,
                "of" | "for"
                    | "with"
                    | "and"
                    | "or"
                    | "to"
                    | "in"
                    | "on"
                    | "data"
                    | "dataset"
                    | "task"
                    | "study"
                    | "problem"
                    | "result"
                    | "comparison"
                    | "evaluation"
            ) {
                break;
            }
        }
    }
    false
}

fn role_hints(text: &str) -> Vec<Focus> {
    let mut roles = Vec::new();
    if any(
        text,
        &[
            "auxiliary",
            "submodel",
            "sub-model",
            "component",
            "pretrained encoder",
            "pre-trained encoder",
            "辅助",
            "子模型",
            "组件",
            "预训练编码器",
        ],
    ) {
        roles.push(Focus::Component);
    }
    if any(
        text,
        &[
            "joint model",
            "joint models",
            "joint bayesian model",
            "multilingual model",
            "multilingual models",
            "ensemble",
            "combined model",
            "combined models",
            "联合模型",
            "组合模型",
            "多语言模型",
            "集成模型",
        ],
    ) || modified_model(text, "joint")
    {
        roles.push(Focus::Composite);
    }
    if any(
        text,
        &[
            "model",
            "models",
            "classifier",
            "classifiers",
            "encoder",
            "encoders",
            "decoder",
            "decoders",
            "network",
            "networks",
            "模型",
            "分类器",
            "编码器",
            "解码器",
            "网络",
        ],
    ) && any(
        text,
        &[
            "individual",
            "per-language",
            "monolingual",
            "single model",
            "单体",
            "单语",
            "各语言模型",
            "独立模型",
        ],
    ) {
        roles.push(Focus::Unit);
    }
    if any(
        text,
        &[
            "main model",
            "main study",
            "main task",
            "overall system",
            "主模型",
            "主研究",
            "主任务",
            "整体系统",
        ],
    ) || modified_model(text, "main")
    {
        roles.push(Focus::StudyIntent);
    }
    roles
}

fn role(text: &str) -> Focus {
    let roles = role_hints(text);
    if roles.len() == 1 {
        roles[0]
    } else {
        Focus::Unspecified
    }
}

fn relations(question: &str) -> BTreeSet<Relation> {
    let mut output = BTreeSet::new();
    for (relation, markers) in [
        (
            Relation::Composition,
            &[
                "consist of",
                "consists of",
                "composed of",
                "components",
                "组成",
                "构成",
            ][..],
        ),
        (
            Relation::Data,
            &[
                "dataset",
                "datasets",
                "corpus",
                "corpora",
                "what data",
                "which data",
                "数据集",
                "语料",
                "什么数据",
                "哪些数据",
            ][..],
        ),
        (
            Relation::Training,
            &["train", "trained", "training", "训练"][..],
        ),
        (
            Relation::Shared,
            &[
                "same weights",
                "share weights",
                "shared weights",
                "weight sharing",
                "same parameters",
                "共享",
                "相同权重",
            ][..],
        ),
        (
            Relation::Comparison,
            &[
                "baseline",
                "compare",
                "compared",
                "contrast",
                "vs",
                "relative to",
                "versus",
                "基线",
                "相比",
                "比较",
            ][..],
        ),
        (
            Relation::Metric,
            &[
                "score",
                "scores",
                "metric",
                "metrics",
                "accuracy",
                "得分",
                "分数",
                "指标",
                "准确率",
            ][..],
        ),
        (
            Relation::Count,
            &["how many", "number of", "人数", "数量", "多少"][..],
        ),
        (
            Relation::Owner,
            &["owner", "responsible", "负责人", "谁负责"][..],
        ),
        (
            Relation::Approval,
            &[
                "approve", "approves", "approval", "approver", "审批", "批准",
            ][..],
        ),
        (
            Relation::Date,
            &["when", "date", "deadline", "日期", "何时", "截止"][..],
        ),
        (
            Relation::Duration,
            &["how long", "retention", "retains", "保留多久", "期限"][..],
        ),
        (
            Relation::Calculation,
            &[
                "calculate",
                "calculated",
                "calculation",
                "compute",
                "computed",
                "formula",
                "计算",
                "公式",
            ][..],
        ),
    ] {
        if any(question, markers) {
            output.insert(relation);
        }
    }
    if output.contains(&Relation::Calculation)
        && output.contains(&Relation::Metric)
        && !any(
            question,
            &["and", "or", "as well as", "以及", "并且", "和", "及"],
        )
    {
        // In "score calculation formula", score is the calculation object,
        // not a separate request for a numeric result.
        output.remove(&Relation::Metric);
    }
    if any(
        question,
        &[
            "how",
            "mechanism",
            "architecture",
            "如何",
            "怎么",
            "机制",
            "架构",
        ],
    ) {
        output.insert(Relation::Mechanism);
    }
    if any(
        question,
        &[
            "what model",
            "which model",
            "what is",
            "模型是什么",
            "使用什么模型",
            "哪种模型",
        ],
    ) || output.is_empty()
    {
        output.insert(Relation::Identity);
    }
    output
}

fn id(reference: &Value) -> Option<&str> {
    reference["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .or_else(|| reference["memoryId"].as_str().filter(|id| !id.is_empty()))
}

fn background(text: &str) -> bool {
    let current = any(
        text,
        &[
            "we",
            "our",
            "this study",
            "this paper",
            "main model",
            "current study",
            "我们",
            "本研究",
            "本文",
            "主模型",
        ],
    );
    if current
        && !any(
            text,
            &["we plan", "we will", "future work", "我们计划", "未来"],
        )
    {
        return false;
    }
    any(
        text,
        &[
            "previous work",
            "prior work",
            "related work",
            "earlier work",
            "in future",
            "future work",
            "we plan",
            "we will",
            "以往工作",
            "相关工作",
            "此前研究",
            "未来",
            "计划",
        ],
    )
}

fn unavailable(text: &str) -> bool {
    any(
        text,
        &[
            "not recorded",
            "not specified",
            "unknown",
            "not stated",
            "not known",
            "not clear",
            "unclear",
            "not provided",
            "not reported",
            "does not state",
            "no information",
            "does not specify",
            "未记录",
            "未说明",
            "未知",
            "不能确认",
            "未给出",
            "未明确",
            "不清楚",
            "未提供",
        ],
    )
}

fn clauses(content: &str) -> impl Iterator<Item = &str> {
    let mut output = Vec::new();
    let mut start = 0;
    for (offset, character) in content.char_indices() {
        if !matches!(
            character,
            '.' | '!' | '?' | ';' | '\n' | '。' | '！' | '？' | '；'
        ) {
            continue;
        }
        let end = offset + character.len_utf8();
        if character == '.' {
            let before = &content[..end];
            let next = content[end..].chars().next();
            if next.is_some_and(char::is_alphanumeric)
                || ["et al.", "e.g.", "i.e.", "Dr.", "Mr.", "Ms.", "Fig.", "Eq."]
                    .iter()
                    .any(|suffix| before.ends_with(suffix))
            {
                continue;
            }
        }
        let part = content[start..end].trim();
        if !part.is_empty() {
            output.push(part);
        }
        start = end;
    }
    let tail = content[start..].trim();
    if !tail.is_empty() {
        output.push(tail);
    }
    output.into_iter()
}

fn model_head(words: &[&str], plural: bool) -> bool {
    for (at, word) in words.iter().take(4).enumerate() {
        if matches!(*word, "of" | "from" | "by" | "using" | "for" | "and" | "or") {
            return false;
        }
        if matches!(*word, "models" | "classifiers" | "networks")
            || (!plural && matches!(*word, "model" | "classifier" | "network"))
        {
            // Model(s) must be the object head, rather than a modifier in
            // "model outputs" or a possessor in "models' output features".
            return words.get(at + 1).is_none_or(|next| {
                matches!(
                    *next,
                    "for" | "and" | "with" | "that" | "which" | "to" | "in" | "as"
                )
            });
        }
    }
    false
}

fn model_object(object: &str, plural: bool) -> bool {
    let head = object.split([',', ';']).next().unwrap_or(object);
    let words = head
        .split(|c: char| !c.is_alphanumeric() && !matches!(c, '-' | '\'' | '’'))
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    model_head(&words, plural)
}

fn composition_role(text: &str, subject: &str, explicit: Focus) -> Focus {
    if explicit != Focus::Unspecified
        || !role_hints(subject).is_empty()
        || any(
            text,
            &[
                "does not consist",
                "do not consist",
                "not composed",
                "not made up",
                "do not make copies",
                "does not couple",
                "never",
                "not",
                "without",
                "don't",
                "doesn't",
                "didn't",
                "cannot",
                "can't",
                "不由",
                "并非由",
                "不包含",
                "不复制",
                "从不复制",
                "不耦合",
            ],
        )
    {
        return explicit;
    }
    let normalized = lower(text);
    let predicate = normalized[subject.len()..].trim_start();
    let object = [
        "consists of",
        "consist of",
        "is composed of",
        "is made up of",
    ]
    .iter()
    .find_map(|marker| predicate.strip_prefix(marker));
    let constituent_models = object.is_some_and(|object| {
        object.split([',', ';']).any(|item| {
            let words = item
                .split(|c: char| !c.is_alphanumeric() && !matches!(c, '-' | '\'' | '’'))
                .filter(|word| !word.is_empty())
                .collect::<Vec<_>>();
            words.iter().enumerate().any(|(at, word)| {
                matches!(*word, "individual" | "monolingual" | "per-language")
                    && words[..at].iter().all(|word| {
                        matches!(
                            *word,
                            "and" | "the" | "several" | "multiple" | "many" | "some" | "distinct"
                        ) || word.chars().all(|c| c.is_ascii_digit())
                    })
                    && model_head(&words[at + 1..], true)
            })
        })
    }) || predicate.strip_prefix('由').is_some_and(|object| {
        ["各语言模型", "多个单语模型", "两个单语模型"]
            .iter()
            .any(|prefix| object.starts_with(prefix))
    });
    let copied_models = predicate
        .strip_prefix("make copies of")
        .is_some_and(|object| model_object(object, false))
        && normalized.match_indices("couple ").any(|(at, marker)| {
            has(&normalized[at..], "couple")
                && (at == 0
                    || !normalized[..at]
                        .chars()
                        .next_back()
                        .is_some_and(char::is_alphanumeric))
                && model_object(&normalized[at + marker.len()..], true)
        });
    if constituent_models || copied_models {
        // A construction explicitly containing/coupling several model units is
        // composite by that relation. No alias, title or preceding paragraph is
        // used to assign an otherwise unnamed model an identity.
        Focus::Composite
    } else {
        explicit
    }
}

fn witness(reference: &Value, text: &str) -> Option<Witness> {
    let id = id(reference)?.to_owned();
    if unavailable(text) {
        return None;
    }
    let lowered = lower(text);
    if lowered.contains("display_equation")
        || lowered.contains("inlineform")
        || lowered.contains("公式占位")
    {
        return None;
    }
    let mut found = None;
    for (relation, markers) in [
        (
            Relation::Calculation,
            &[
                "calculated by",
                "computed by",
                "defined as",
                "is the sum of",
                "计算为",
                "计算方法",
                "定义为",
                "公式为",
            ][..],
        ),
        (
            Relation::Composition,
            &[
                "consists of",
                "consist of",
                "is composed of",
                "is made up of",
                "make copies of",
                "由",
                "组成",
                "构成",
            ][..],
        ),
        (
            Relation::Training,
            &[
                "is trained on",
                "was trained on",
                "are trained on",
                "trained using",
                "trained with",
                "training on",
                "train on",
                "训练于",
                "训练使用",
                "用于训练",
            ][..],
        ),
        (
            Relation::Shared,
            &[
                "share weights",
                "shares weights",
                "shared weights",
                "same weights",
                "share parameters",
                "共享权重",
                "相同权重",
                "共享参数",
            ][..],
        ),
        (Relation::Mechanism, &["output is", "输出为"][..]),
        (
            Relation::Mechanism,
            &[
                "takes as input",
                "take as input",
                "is used to initialize",
                "used to initialize",
                "we use",
                "we take",
                "we output",
                "we choose",
                "we concatenate",
                "作为输入",
                "用于初始化",
                "我们使用",
                "我们取",
                "我们输出",
                "我们选择",
                "拼接输出",
            ][..],
        ),
        (
            Relation::Identity,
            &[
                "is based on",
                "based on",
                "is a copy of",
                "is the",
                "is a",
                "基于",
                "是",
            ][..],
        ),
        (
            Relation::Owner,
            &["is responsible", "owner is", "负责", "负责人"][..],
        ),
        (
            Relation::Approval,
            &[
                "approves",
                "approve",
                "approver is",
                "approval by",
                "审批",
                "批准",
            ][..],
        ),
        (
            Relation::Date,
            &["deadline is", "due on", "截止", "日期为"][..],
        ),
        (
            Relation::Duration,
            &["retains", "retain", "retention period", "保留"][..],
        ),
        (
            Relation::Metric,
            &[
                "achieves",
                "achieved",
                "score of",
                "accuracy of",
                "得分",
                "分数为",
                "准确率",
            ][..],
        ),
        (
            Relation::Data,
            &[
                "collected from",
                "obtained from",
                "sourced from",
                "extracted from",
                "data from",
                "corpus from",
                "dataset from",
                "采集自",
                "收集自",
                "数据来自",
                "语料来自",
            ][..],
        ),
        (
            Relation::Mechanism,
            &[
                "predicts",
                "classifies",
                "output is",
                "uses",
                "captures",
                "is captured by",
                "预测",
                "输出为",
                "使用",
                "捕获",
            ][..],
        ),
    ] {
        for marker in markers {
            if let Some(at) = lowered.find(marker) {
                if has(text, marker) {
                    found = Some((relation, at));
                    break;
                }
            }
        }
        if found.is_some() {
            break;
        }
    }
    // A local role-definition is an explicit binding, unlike two names merely
    // co-occurring in a paragraph. It never creates a cross-record alias.
    let definition = [
        "as our base",
        "as the base",
        "as our individual",
        "作为基础",
        "作为单语",
        "作为独立",
    ]
    .iter()
    .find_map(|marker| lowered.find(marker).map(|at| (at, *marker)));
    let training_object = ["while training ", "when training "]
        .iter()
        .find_map(|marker| {
            lowered.find(marker).map(|at| {
                let tail = &text[at + marker.len()..];
                tail.split([',', ';', '，', '；'])
                    .next()
                    .unwrap_or(tail)
                    .trim()
            })
        });
    let (relation, subject, target_role) = if let Some(subject) = training_object {
        (Relation::Training, subject.to_owned(), role(subject))
    } else if let Some((at, marker)) = definition {
        if !any(
            &text[..at],
            &["we use", "we adopt", "we employ", "我们使用", "我们采用"],
        ) {
            return None;
        }
        (
            Relation::Identity,
            text[..at].trim().to_owned(),
            role(&text[at + marker.len()..]),
        )
    } else if let Some((relation, at)) = found {
        let subject = text[..at].trim();
        (relation, subject.to_owned(), role(subject))
    } else {
        return None;
    };
    let target_role = if relation == Relation::Composition {
        composition_role(text, &subject, target_role)
    } else {
        target_role
    };
    Some(Witness {
        id,
        role: target_role,
        relation,
        subject,
        literal: text.to_owned(),
        background: background(text),
    })
}

fn matches_relation(asked: &BTreeSet<Relation>, evidence: Relation) -> bool {
    asked.contains(&evidence)
        || (asked.contains(&Relation::Composition) && evidence == Relation::Identity)
        || (asked.contains(&Relation::Data) && evidence == Relation::Training)
}

fn other_focus(target: Focus, evidence: Focus) -> bool {
    matches!(
        (target, evidence),
        (Focus::Unit, Focus::Composite)
            | (Focus::Composite, Focus::Unit)
            | (Focus::StudyIntent, Focus::Component)
    )
}

fn aligned_focus(target: Focus, evidence: Focus) -> bool {
    target != Focus::Unspecified && target == evidence
}

fn contains_unit_argument(witness: &Witness) -> bool {
    if witness.relation != Relation::Composition {
        return false;
    }
    let normalized = lower(&witness.literal);
    let predicate = normalized[witness.subject.len()..].trim_start();
    [
        "consists of",
        "consist of",
        "is composed of",
        "is made up of",
        "make copies of",
        "由",
        "组成",
        "构成",
    ]
    .iter()
    .filter_map(|marker| predicate.strip_prefix(marker))
    .any(|object| {
        if role_hints(object).contains(&Focus::Unit) {
            return true;
        }
        let words = object
            .split(|c: char| !c.is_alphanumeric() && !matches!(c, '-' | '\'' | '’'))
            .filter(|word| !word.is_empty())
            .collect::<Vec<_>>();
        words
            .iter()
            .enumerate()
            .any(|(at, word)| *word == "language-specific" && model_head(&words[at + 1..], false))
    })
}

fn variable_cardinality(text: &str) -> bool {
    (any(text, &["variable", "varying", "unknown", "unbounded"])
        && any(
            text,
            &["number", "amount", "length", "cardinality", "count"],
        ))
        || any(
            text,
            &[
                "可变数量",
                "未知数量",
                "不同数量",
                "可变长度",
                "未知长度",
                "数量可变",
                "数量未知",
            ],
        )
}

fn gap_main_clause(gap: &str) -> &str {
    gap.split(['(', '（']).next().unwrap_or(gap).trim()
}

impl TargetPlan {
    fn cardinality_mechanism_gap(&self, gap: &str) -> bool {
        let core = gap_main_clause(gap);
        self.relations.contains(&Relation::Mechanism)
            && variable_cardinality(&self.question)
            && variable_cardinality(core)
            && !any(
                core,
                &[
                    "batch",
                    "batching",
                    "padding",
                    "dimension",
                    "dimensions",
                    "dimensionality",
                    "tensor shape",
                    "批处理",
                    "批次",
                    "填充",
                    "维度",
                    "张量形状",
                ],
            )
    }

    fn excluded_background(&self, witness: &Witness) -> bool {
        witness.background
            && self.focus != Focus::Unspecified
            && !any(
                &self.question,
                &[
                    "prior",
                    "previous",
                    "earlier",
                    "related work",
                    "future",
                    "planned",
                    "以往",
                    "之前",
                    "相关工作",
                    "未来",
                    "计划",
                ],
            )
    }
    pub(crate) fn analyze(question: &str, references: &[Value]) -> Self {
        let asked = relations(question);
        let mut focus = role(question);
        // A different-level comparison baseline is still a legitimate answer.
        if asked.contains(&Relation::Comparison) {
            focus = Focus::Unspecified;
        }
        if focus == Focus::Unspecified
            && role_hints(question).is_empty()
            && !asked.contains(&Relation::Comparison)
            && any(
                question,
                &["model", "system", "network", "模型", "系统", "网络"],
            )
            && asked.iter().any(|relation| {
                matches!(
                    relation,
                    Relation::Data | Relation::Training | Relation::Mechanism | Relation::Metric
                )
            })
            && !any(
                question,
                &[
                    "baseline",
                    "previous",
                    "prior",
                    "related",
                    "基线",
                    "以往",
                    "相关工作",
                ],
            )
        {
            // An intent to answer at study level is not an identity assertion.
            focus = Focus::StudyIntent;
        }
        let query = Query::new(question);
        let mut names = Vec::new();
        for reference in references {
            if let Some(name) = reference["facets"]["entity"]
                .as_str()
                .filter(|name| query.names_entity(name))
            {
                if !names.iter().any(|existing| existing == name) {
                    names.push(name.to_owned());
                }
            }
        }
        if !names.is_empty() && role_hints(question).is_empty() && focus == Focus::StudyIntent {
            // A scope-bound literal name selects its own model. The generic
            // study-level intent must not relabel a named auxiliary as main.
            focus = Focus::Unspecified;
        }
        let witnesses = references
            .iter()
            .flat_map(|reference| {
                clauses(reference["content"].as_str().unwrap_or(""))
                    .filter_map(|text| witness(reference, text))
                    .collect::<Vec<_>>()
            })
            .collect();
        Self {
            question: question.to_owned(),
            focus,
            relations: asked,
            names,
            witnesses,
        }
    }

    pub(crate) fn model_view(&self) -> Value {
        let distinct = self
            .witnesses
            .iter()
            .map(|w| format!("{:?}:{}", w.role, w.subject))
            .collect::<BTreeSet<_>>();
        if self.focus == Focus::Unspecified
            || (self.focus == Focus::StudyIntent && distinct.len() < 2)
        {
            return Value::Null;
        }
        let mut view = json!({"version":VERSION,"intent":format!("{:?}",self.focus),
            "requested":self.relations.iter().map(|r|format!("{r:?}")).collect::<Vec<_>>(),
            "identityNotInferred":true,"witnesses":[]});
        let mut ranked = self
            .witnesses
            .iter()
            .filter(|w| {
                (matches_relation(&self.relations, w.relation)
                    || (self.focus == Focus::StudyIntent
                        && self.relations.contains(&Relation::Data)
                        && w.relation == Relation::Mechanism))
                    && (!matches!(
                        self.focus,
                        Focus::Unit | Focus::Composite | Focus::Component
                    ) || aligned_focus(self.focus, w.role)
                        || other_focus(self.focus, w.role)
                        || self.names.iter().any(|name| has(&w.subject, name)))
            })
            .collect::<Vec<_>>();
        ranked.sort_by_key(|w| {
            (
                w.background,
                !aligned_focus(self.focus, w.role),
                other_focus(self.focus, w.role),
            )
        });
        let mut selected = Vec::new();
        let mut covered_relations = BTreeSet::new();
        for item in ranked {
            // Whole literal clauses only: no clipped quote presented as a fact.
            if item.literal.chars().count() > 320 {
                continue;
            }
            if self.focus == Focus::StudyIntent
                && self.relations.contains(&Relation::Data)
                && covered_relations.contains(&item.relation)
            {
                continue;
            }
            let row = json!({"id":item.id,"role":format!("{:?}",item.role),
                "relation":format!("{:?}",item.relation),"literal":item.literal,"background":item.background});
            if selected.contains(&row) {
                continue;
            }
            selected.push(row);
            view["witnesses"] = json!(selected);
            if view.to_string().chars().count() > MAX_VIEW_CHARS {
                selected.pop();
                view["witnesses"] = json!(selected);
            } else {
                covered_relations.insert(item.relation);
            }
            if selected.len() == 3 {
                break;
            }
        }
        if selected.is_empty() {
            Value::Null
        } else {
            view
        }
    }

    pub(crate) fn claim_scope(&self, claim: &Value, references: &[Value]) -> ClaimScope {
        let claim_text = claim["text"].as_str().unwrap_or("");
        let claim_witness = witness(&json!({"id":"claim"}), claim_text);
        if claim_witness
            .as_ref()
            .is_some_and(|w| other_focus(self.focus, w.role))
        {
            return ClaimScope::OtherExplicitTarget;
        }
        let mut anchored = Vec::new();
        for quote in claim["supportQuotes"].as_array().into_iter().flatten() {
            let Some(citation) = quote["citationId"].as_str() else {
                continue;
            };
            let Some(reference) = references
                .iter()
                .find(|r| r["id"] == citation || r["memoryId"] == citation)
            else {
                continue;
            };
            let Some(literal) = quote["quote"].as_str().filter(|text| {
                !text.is_empty()
                    && reference["content"]
                        .as_str()
                        .is_some_and(|body| body.contains(text))
            }) else {
                continue;
            };
            anchored.extend(clauses(literal).filter_map(|text| witness(reference, text)));
        }
        let relevant = anchored
            .iter()
            .filter(|w| matches_relation(&self.relations, w.relation))
            .collect::<Vec<_>>();
        let compatible = relevant.iter().any(|w| {
            !self.excluded_background(w)
                && (aligned_focus(self.focus, w.role)
                    || self.names.iter().any(|name| has(&w.subject, name)))
        });
        if compatible {
            return ClaimScope::CompatibleWitness;
        }
        if !relevant.is_empty()
            && relevant
                .iter()
                .all(|w| other_focus(self.focus, w.role) || self.excluded_background(w))
        {
            if claim_witness
                .as_ref()
                .is_some_and(|w| aligned_focus(self.focus, w.role))
                && relevant.iter().all(|w| other_focus(self.focus, w.role))
            {
                return ClaimScope::Contradiction;
            }
            return ClaimScope::OtherExplicitTarget;
        }
        ClaimScope::Unresolved
    }

    pub(crate) fn gap_scope(&self, gap: &str) -> GapScope {
        if gap.trim().is_empty() {
            return GapScope::Unresolved;
        }
        if gap.trim() == self.question.trim() {
            return GapScope::ExplicitlyAsked;
        }
        if self.cardinality_mechanism_gap(gap) {
            // An unasked implementation example in parentheses cannot change
            // the scope of an explicitly asked variable-cardinality relation.
            return GapScope::ExplicitlyAsked;
        }
        for (relation, markers) in [
            (
                Relation::Shared,
                &["weights", "parameters", "sharing", "共享", "权重"][..],
            ),
            (
                Relation::Comparison,
                &["baseline", "compared", "comparison", "基线", "比较"][..],
            ),
            (
                Relation::Owner,
                &["owner", "responsible", "负责人", "谁负责"][..],
            ),
            (
                Relation::Approval,
                &[
                    "approve", "approves", "approval", "approver", "审批", "批准",
                ][..],
            ),
            (Relation::Date, &["date", "deadline", "日期", "截止"][..]),
            (
                Relation::Duration,
                &["how long", "retention", "duration", "多久", "保留", "期限"][..],
            ),
            (
                Relation::Calculation,
                &[
                    "calculation",
                    "calculated",
                    "computed",
                    "formula",
                    "method",
                    "计算",
                    "公式",
                    "方法",
                ][..],
            ),
        ] {
            if self.relations.contains(&relation) && any(gap, markers) {
                return GapScope::ExplicitlyAsked;
            }
        }
        if any(gap, &["formula", "calculation", "计算公式", "计算方法"])
            && !self.relations.contains(&Relation::Calculation)
        {
            return GapScope::UnaskedDetail;
        }
        for detail in [
            &["batch", "batching", "padding", "批处理", "批次", "填充"][..],
            &[
                "dimension",
                "dimensions",
                "dimensionality",
                "tensor shape",
                "维度",
                "张量形状",
            ][..],
            &[
                "complexity",
                "runtime",
                "memory complexity",
                "复杂度",
                "运行耗时",
            ][..],
            &[
                "per-metric",
                "individual scores",
                "each metric",
                "subscores",
                "sub-scores",
                "各指标",
                "分项得分",
                "单独分数",
            ][..],
            &[
                "global ranking",
                "worldwide",
                "across all studies",
                "all possible models",
                "全球排名",
                "所有研究",
                "全局排名",
            ][..],
        ] {
            if any(gap, detail) && !any(&self.question, detail) {
                return GapScope::UnaskedDetail;
            }
            if any(gap, detail) && any(&self.question, detail) {
                return GapScope::ExplicitlyAsked;
            }
        }
        if any(
            gap,
            &[
                "internal structure",
                "internal components",
                "内部结构",
                "内部组成",
            ],
        ) && !self.relations.contains(&Relation::Composition)
            && !any(
                &self.question,
                &["architecture", "structure", "架构", "结构"],
            )
        {
            return GapScope::UnaskedDetail;
        }
        for (relation, markers) in [
            (
                Relation::Data,
                &["dataset", "corpus", "corpora", "data", "数据", "语料"][..],
            ),
            (
                Relation::Training,
                &["training", "trained", "train", "训练"][..],
            ),
            (
                Relation::Composition,
                &[
                    "components",
                    "structure",
                    "composition",
                    "组成",
                    "构成",
                    "结构",
                ][..],
            ),
            (
                Relation::Mechanism,
                &[
                    "mechanism",
                    "architecture",
                    "method",
                    "how",
                    "机制",
                    "架构",
                    "方法",
                    "如何",
                ][..],
            ),
            (
                Relation::Metric,
                &["score", "metric", "ranking", "分数", "得分", "排名"][..],
            ),
            (Relation::Count, &["number", "count", "人数", "数量"][..]),
        ] {
            if self.relations.contains(&relation) && any(gap, markers) {
                return GapScope::ExplicitlyAsked;
            }
        }
        GapScope::Unresolved
    }

    pub(crate) fn supplement_queries(&self, gaps: &[String]) -> Vec<String> {
        let mut output = Vec::new();
        for gap in gaps
            .iter()
            .filter(|gap| self.gap_scope(gap) == GapScope::ExplicitlyAsked)
        {
            // The caller retains the original question in the retrieval payload.
            // Do not let a long question truncate the gap out of every rewrite.
            let query = if self.cardinality_mechanism_gap(gap) {
                gap_main_clause(gap)
            } else {
                gap.trim()
            }
            .chars()
            .take(160)
            .collect::<String>();
            if query.chars().count() >= 2 && !output.contains(&query) {
                output.push(query);
            }
            if output.len() == 3 {
                break;
            }
        }
        output
    }

    /// Navigation candidates only. The caller must bind each ID back to its
    /// original current full reference and retain all conditions and unknowns.
    pub(crate) fn correction_candidates(
        &self,
        used_reference_ids: &[String],
    ) -> Vec<CandidateWitness> {
        if !matches!(self.focus, Focus::Unit | Focus::Composite)
            || self.relations.contains(&Relation::Comparison)
            || self.names.len() > 1
            || any(
                &self.question,
                &[
                    "models",
                    "classifiers",
                    "networks",
                    "both",
                    "each model",
                    "between",
                    "各模型",
                    "两个模型",
                    "多个模型",
                ],
            )
        {
            return Vec::new();
        }
        let canonical = |id: &str| id.strip_prefix("memory:").unwrap_or(id).to_owned();
        let mut selected = BTreeSet::new();
        let mut output = Vec::new();
        for w in &self.witnesses {
            let key = canonical(&w.id);
            if !aligned_focus(self.focus, w.role)
                || !matches_relation(&self.relations, w.relation)
                || self.excluded_background(w)
                || (!self.names.is_empty() && !self.names.iter().any(|name| has(&w.subject, name)))
                || used_reference_ids.iter().any(|id| canonical(id) == key)
                || selected.contains(&key)
                || self.witnesses.iter().any(|other| {
                    canonical(&other.id) == key
                        && matches_relation(&self.relations, other.relation)
                        && (!aligned_focus(self.focus, other.role)
                            || self.excluded_background(other))
                })
            {
                continue;
            }
            selected.insert(key);
            output.push(CandidateWitness {
                reference_id: w.id.clone(),
                gap_index: 0,
                reason: format!("original-current-single-target-{:?}-correction", w.relation),
                anchors: vec![w.anchor()],
            });
            if output.len() == 6 {
                break;
            }
        }
        output
    }

    pub(crate) fn supplement_candidates(
        &self,
        gaps: &[String],
        new_refs: &[Value],
    ) -> Vec<CandidateWitness> {
        let mut output = Vec::new();
        for (gap_index, gap) in gaps
            .iter()
            .enumerate()
            .filter(|(_, gap)| self.gap_scope(gap) == GapScope::ExplicitlyAsked)
        {
            let mut gap_relations = relations(gap)
                .intersection(&self.relations)
                .copied()
                .collect::<BTreeSet<_>>();
            if self.cardinality_mechanism_gap(gap) {
                gap_relations.insert(Relation::Mechanism);
            }
            for reference in new_refs {
                let Some(reference_id) = id(reference) else {
                    continue;
                };
                let found = clauses(reference["content"].as_str().unwrap_or(""))
                    .filter_map(|text| witness(reference, text))
                    .find(|w| {
                        !self.excluded_background(w)
                            && matches_relation(&gap_relations, w.relation)
                            && !other_focus(self.focus, w.role)
                            && (aligned_focus(self.focus, w.role)
                                || self.names.iter().any(|name| has(&w.subject, name))
                                || (matches!(self.focus, Focus::Unspecified | Focus::StudyIntent)
                                    && self.names.is_empty()
                                    && w.role == Focus::Unspecified
                                    && (Query::new(gap).score("", &w.literal) > 0
                                        || Query::new(&self.question).score("", &w.literal) > 0)))
                    });
                if let Some(w) = found {
                    output.push(CandidateWitness {
                        reference_id: reference_id.to_owned(),
                        gap_index,
                        reason: format!(
                            "current-literal-{:?}-relation{}",
                            w.relation,
                            if w.role == Focus::Unspecified {
                                "-unresolved-role-navigation"
                            } else {
                                ""
                            }
                        ),
                        anchors: vec![w.anchor()],
                    });
                }
            }
        }
        output
    }
}

pub(crate) fn model_view(question: &str, references: &[Value]) -> Value {
    TargetPlan::analyze(question, references).model_view()
}

/// A model-input projection only; the validated snapshot stays intact. Any
/// unknown target or mixed/unparsed sentence keeps its entire original record.
pub(crate) fn model_target_references(question: &str, references: &[Value]) -> Vec<Value> {
    let plan = TargetPlan::analyze(question, references);
    if plan.correction_candidates(&[]).is_empty()
        || plan.relations.contains(&Relation::Shared)
        || any(
            question,
            &[
                "differ",
                "differs",
                "difference",
                "different",
                "distinguish",
                "rather than",
                "区别",
                "差别",
            ],
        )
    {
        return references.to_vec();
    }
    references
        .iter()
        .filter(|reference| {
            let Some(body) = reference["content"]
                .as_str()
                .filter(|body| !body.trim().is_empty())
            else {
                return true;
            };
            let mut asked_opposite = false;
            for clause in clauses(body) {
                if unavailable(clause) {
                    return true;
                }
                if let Some(w) = witness(reference, clause) {
                    if plan.focus == Focus::Unit && contains_unit_argument(&w) {
                        // A whole's definition can also explicitly describe
                        // the queried member role. Keep the complete relation
                        // for navigation; it does not prove member composition.
                        return true;
                    }
                    if !other_focus(plan.focus, w.role) {
                        return true;
                    }
                    asked_opposite |= matches_relation(&plan.relations, w.relation);
                } else if !other_focus(plan.focus, role(clause)) {
                    return true;
                }
            }
            !asked_opposite
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reference(id: &str, body: &str) -> Value {
        json!({"id":id,"memoryId":id,"projectId":"p","revision":2,"content":body,"facets":{}})
    }
    fn claim(text: &str, reference: &Value) -> Value {
        json!({"text":text,"citationIds":[reference["id"]],"supportQuotes":[{"citationId":reference["id"],"quote":reference["content"]}]})
    }

    #[test]
    fn target_projection_removes_only_an_entire_explicit_opposite_record() {
        let joint = reference(
            "joint",
            "We propose a joint model for multiple domains. The joint model is based on alignment constraints.",
        );
        let mut base = reference(
            "base",
            "For offline trials, we use the Cedar method as our base monolingual model. The semantic roles are predicate-specific.",
        );
        base["facets"] = json!({"conditions":["For offline trials"],"validFrom":"2026-10-01","role":"offline operator"});
        let uncertain = reference("uncertain", "The model consists of scalar features.");
        let refs = vec![joint.clone(), base.clone(), uncertain.clone()];
        let original = refs.clone();
        let selected = model_target_references("What does an individual model consist of?", &refs);
        assert_eq!(selected, vec![base, uncertain]);
        assert_eq!(refs, original);
        assert_eq!(refs[0], joint);
        let unit = reference("unit", "The individual model is based on the Cedar method.");
        let refs = vec![unit, refs[0].clone()];
        assert_eq!(
            model_target_references("What does the joint model consist of?", &refs),
            vec![refs[1].clone()]
        );
    }

    #[test]
    fn target_projection_preserves_mixed_unknown_and_unparsed_reference_bodies() {
        let base = reference(
            "base",
            "We use the Cedar method as our base monolingual model.",
        );
        let refs = vec![
            base,
            reference("mixed", "The joint model consists of individual models. The individual model is based on a tree method."),
            reference("unparsed", "The joint model consists of individual models. Additional constraints apply."),
            reference("unknown", "The joint model consists of individual models. Its relationship to the individual model is not recorded."),
            reference("generic", "The model consists of scalar features."),
        ];
        assert_eq!(
            model_target_references("What does an individual model consist of?", &refs),
            refs
        );
    }

    #[test]
    fn target_projection_keeps_explicit_member_arguments_without_promoting_whole_composition() {
        let mut whole = reference(
            "whole",
            "For archived domains, the joint model consists of individual tree models for each domain and alignment constraints.",
        );
        whole["facets"] = json!({"conditions":["For archived domains"],"role":"offline","validUntil":"2027-01-01"});
        let copies = reference(
            "copies",
            "We make copies of the monolingual model for each domain and add links to couple the monolingual models.",
        );
        let base = reference(
            "base",
            "We use the Cedar method as our base monolingual model.",
        );
        let refs = vec![whole.clone(), copies, base];
        let original = refs.clone();
        let question = "What does the individual model consist of?";
        assert_eq!(model_target_references(question, &refs), refs);
        assert_eq!(refs, original);
        let plan = TargetPlan::analyze(question, &refs);
        assert_eq!(
            plan.claim_scope(&claim(whole["content"].as_str().unwrap(), &whole), &refs),
            ClaimScope::OtherExplicitTarget
        );
        assert_eq!(
            plan.claim_scope(
                &claim(
                    "The individual model consists of tree models and alignment constraints.",
                    &whole
                ),
                &refs
            ),
            ClaimScope::Contradiction
        );
    }

    #[test]
    fn language_specific_member_heads_are_navigation_but_their_outputs_are_not_model_units() {
        let base = reference(
            "base",
            "We use a tree method as our base monolingual model.",
        );
        let question = "What does the individual model consist of?";
        for body in [
            "The joint model consists of language-specific models and shared alignment variables.",
            "The joint model consists of language-specific probabilistic models and shared alignment variables.",
        ] {
            let whole = reference("whole", body);
            let refs = vec![whole.clone(), base.clone()];
            assert_eq!(model_target_references(question, &refs), refs);
            assert_eq!(TargetPlan::analyze(question, &refs).claim_scope(&claim(body, &whole), &refs), ClaimScope::OtherExplicitTarget);
        }
        for body in [
            "The joint model consists of language-specific model outputs and shared alignment features.",
            "The joint model consists of language-specific models' output features and shared alignment features.",
            "The joint model consists of language-specific features from a model and a shared scalar.",
        ] {
            let refs = vec![reference("whole",body),base.clone()];
            assert_eq!(model_target_references(question,&refs),vec![base.clone()],"{body}");
        }
    }

    #[test]
    fn cardinality_mechanism_keeps_the_asked_gap_and_does_not_query_implementation_examples() {
        let question = "How does the model process an unknown number of records?";
        let plan = TargetPlan::analyze(question, &[]);
        let gap = "The mechanism for processing a variable number of records is unknown (e.g. padding, batching or tensor dimensions).".to_owned();
        assert_eq!(plan.gap_scope(&gap), GapScope::ExplicitlyAsked);
        let queries = plan.supplement_queries(std::slice::from_ref(&gap));
        assert_eq!(
            queries,
            vec!["The mechanism for processing a variable number of records is unknown"]
        );
        assert_eq!(
            plan.gap_scope("Padding for a variable number of records is unknown."),
            GapScope::UnaskedDetail
        );
        assert_eq!(
            plan.gap_scope("variable or unbounded number of records"),
            GapScope::ExplicitlyAsked
        );
        let operation = reference(
            "operation",
            "We output a score for each record and choose the highest score.",
        );
        let found = plan.supplement_candidates(
            &["variable or unbounded number of records".to_owned()],
            std::slice::from_ref(&operation),
        );
        assert_eq!(found.len(), 1);
        assert!(found[0].reason.contains("unresolved-role-navigation"));
        assert_eq!(
            plan.claim_scope(
                &claim(operation["content"].as_str().unwrap(), &operation),
                &[operation]
            ),
            ClaimScope::Unresolved
        );
        let explicit = TargetPlan::analyze(
            "How does the model process a variable number of records and what padding is used?",
            &[],
        );
        assert_eq!(
            explicit.gap_scope("Padding for a variable number of records is unknown."),
            GapScope::ExplicitlyAsked
        );
        assert!(explicit.supplement_queries(&[
            "Padding for a variable number of records is unknown.".to_owned()
        ])[0]
            .contains("Padding"));
        let identity = TargetPlan::analyze("What model is used?", &[]);
        assert_ne!(identity.gap_scope(&gap), GapScope::ExplicitlyAsked);
    }

    #[test]
    fn target_projection_needs_a_compatible_single_noncomparative_target() {
        let refs = vec![
            reference(
                "joint",
                "The joint model consists of individual models and shared links.",
            ),
            reference("unit", "The individual model is based on the Cedar method."),
        ];
        for question in [
            "Compare the individual and joint models.",
            "How does the individual model differ from another method?",
            "What do individual models consist of?",
            "How does the model work?",
            "Do the individual model and the joint one share weights?",
        ] {
            assert_eq!(model_target_references(question, &refs), refs, "{question}");
        }
        assert_eq!(
            model_target_references("What does an individual model consist of?", &refs[..1]),
            refs[..1]
        );
        let no_relation = vec![
            refs[0].clone(),
            reference(
                "unit",
                "The individual model is trained on archived records.",
            ),
        ];
        assert_eq!(
            model_target_references("What does an individual model consist of?", &no_relation),
            no_relation
        );
    }

    #[test]
    fn correction_navigation_uses_only_unused_explicit_original_target_relations() {
        let base = reference(
            "base",
            "For offline trials, we use the Cedar method as our base monolingual model.",
        );
        let refs = vec![
            reference(
                "wrong",
                "The joint model consists of individual models and shared links.",
            ),
            reference("unresolved", "The model is based on a recurrent method."),
            reference(
                "prior",
                "Previous work used an individual model that is based on a linear method.",
            ),
            reference(
                "used",
                "The individual model is based on an earlier method.",
            ),
            base.clone(),
        ];
        let plan = TargetPlan::analyze("What does the individual model consist of?", &refs);
        let witnesses = plan.correction_candidates(&["memory:used".to_owned()]);
        assert_eq!(witnesses.len(), 1);
        assert_eq!(witnesses[0].reference_id, "base");
        assert_eq!(witnesses[0].anchors[0]["literal"], base["content"]);
        assert!(witnesses[0]
            .reason
            .contains("original-current-single-target"));
        assert_eq!(refs[0]["id"], "wrong");
        let used = plan.correction_candidates(&["base".to_owned(), "used".to_owned()]);
        assert!(used.is_empty());
    }

    #[test]
    fn correction_navigation_rejects_multiple_targets_and_mixed_full_references() {
        let mixed = reference(
            "mixed",
            "We use the Cedar method as our base monolingual model. The joint model consists of individual models and shared links.",
        );
        let unclear = reference(
            "unclear",
            "The individual model is based on the Cedar method. A library is a reusable module.",
        );
        let refs = vec![mixed, unclear];
        for question in [
            "What does the individual model consist of?",
            "Compare the individual and joint models.",
            "What do individual models consist of?",
            "How is the model trained?",
            "How is the auxiliary model trained?",
        ] {
            assert!(
                TargetPlan::analyze(question, &refs)
                    .correction_candidates(&[])
                    .is_empty(),
                "{question}"
            );
        }
        let mut cedar = reference(
            "cedar",
            "The individual Cedar model is based on a tree method.",
        );
        cedar["facets"] = json!({"entity":"Cedar"});
        let mut maple = reference(
            "maple",
            "The individual Maple model is based on a graph method.",
        );
        maple["facets"] = json!({"entity":"Maple"});
        assert!(TargetPlan::analyze(
            "What does the individual Cedar model and Maple model consist of?",
            &[cedar.clone(), maple.clone()],
        )
        .correction_candidates(&[])
        .is_empty());
        let named = TargetPlan::analyze(
            "What does the individual Cedar model consist of?",
            &[cedar, maple],
        );
        assert_eq!(
            named
                .correction_candidates(&[])
                .iter()
                .map(|w| w.reference_id.as_str())
                .collect::<Vec<_>>(),
            vec!["cedar"]
        );
    }

    #[test]
    fn correction_navigation_has_six_original_ids_and_never_substitutes_a_relation() {
        let refs = (0..8)
            .map(|index| {
                reference(
                    &format!("r{index}"),
                    &format!("The individual model is based on technique {index}."),
                )
            })
            .collect::<Vec<_>>();
        let plan = TargetPlan::analyze("What does an individual model consist of?", &refs);
        let witnesses = plan.correction_candidates(&[]);
        assert_eq!(witnesses.len(), 6);
        assert_eq!(
            witnesses
                .iter()
                .map(|w| w.reference_id.as_str())
                .collect::<Vec<_>>(),
            vec!["r0", "r1", "r2", "r3", "r4", "r5"]
        );
        let training = TargetPlan::analyze("What dataset trains the individual model?", &refs);
        assert!(training.correction_candidates(&[]).is_empty());
        let joint = reference(
            "joint",
            "The joint model consists of individual models and alignment variables.",
        );
        let plan = TargetPlan::analyze(
            "What does the joint model consist of?",
            std::slice::from_ref(&joint),
        );
        assert_eq!(plan.correction_candidates(&[])[0].reference_id, "joint");
    }

    #[test]
    fn literal_model_units_define_a_composite_without_a_joint_label() {
        let unit = reference("u", "We use a tree method as our base monolingual model.");
        for body in [
            "The model consists of individual tree models for each domain and alignment variables.",
            "The system is composed of monolingual models and alignment constraints.",
            "We make copies of the model for each region and add links to couple the models.",
            "模型由各语言模型构成。",
        ] {
            let composite = reference("c", body);
            let plan = TargetPlan::analyze(
                "What does the individual model consist of?",
                &[unit.clone(), composite.clone()],
            );
            assert_eq!(
                plan.claim_scope(&claim(body, &composite), std::slice::from_ref(&composite)),
                ClaimScope::OtherExplicitTarget,
                "{body}"
            );
            let misattributed = claim(
                "The individual model consists of individual tree models and alignment variables.",
                &composite,
            );
            assert_eq!(
                plan.claim_scope(&misattributed, &[composite]),
                ClaimScope::Contradiction,
                "{body}"
            );
        }
    }

    #[test]
    fn composition_does_not_bind_models_mentioned_as_feature_sources_or_negated_actions() {
        for body in [
            "The model consists of features from individual tree models.",
            "The model consists of individual variables and a scalar score from many models.",
            "The model does not consist of monolingual models.",
            "We do not make copies of the model to couple the models.",
            "We never make copies of the model or couple the models.",
            "We don't make copies of the model or couple the models.",
            "We make copies of the individual model outputs and couple the resulting vectors.",
            "We make copies of the model and couple the model parameters.",
            "We make copies of the model's outputs and couple the models.",
            "The model consists of monolingual models' output features.",
            "The model consists of monolingual models’ output features.",
            "Unlike the joint model, the individual model consists of monolingual models.",
            "模型由来自各语言模型的特征构成。",
        ] {
            let r = reference("x", body);
            let plan = TargetPlan::analyze(
                "What does an individual model consist of?",
                std::slice::from_ref(&r),
            );
            assert_eq!(
                plan.claim_scope(&claim(body, &r), std::slice::from_ref(&r)),
                ClaimScope::Unresolved,
                "{body}"
            );
        }
        let explicit = reference(
            "explicit",
            "The individual model consists of monolingual models and features.",
        );
        let plan = TargetPlan::analyze(
            "What does an individual model consist of?",
            std::slice::from_ref(&explicit),
        );
        assert_eq!(
            plan.claim_scope(
                &claim(explicit["content"].as_str().unwrap(), &explicit),
                &[explicit]
            ),
            ClaimScope::CompatibleWitness
        );
    }

    #[test]
    fn copying_outputs_never_turns_their_individual_model_into_a_composite() {
        let body = reference(
            "outputs",
            "We make copies of the individual model outputs and couple the resulting vectors.",
        );
        let plan = TargetPlan::analyze(
            "How are individual model outputs processed?",
            std::slice::from_ref(&body),
        );
        assert_eq!(
            plan.claim_scope(&claim(body["content"].as_str().unwrap(), &body), &[body]),
            ClaimScope::Unresolved
        );
        let positive = reference(
            "models",
            "We make copies of the monolingual model for each region and couple the monolingual models, capturing common patterns.",
        );
        let plan = TargetPlan::analyze(
            "What does the individual model consist of?",
            std::slice::from_ref(&positive),
        );
        assert_eq!(
            plan.claim_scope(
                &claim(positive["content"].as_str().unwrap(), &positive),
                &[positive]
            ),
            ClaimScope::OtherExplicitTarget
        );
    }

    #[test]
    fn explicit_target_view_does_not_fill_with_unbound_type_introductions() {
        let refs = vec![
            reference(
                "other",
                "An alignment method is based on a hidden-state process.",
            ),
            reference(
                "base",
                "We use a tree method as our base monolingual model.",
            ),
            reference(
                "whole",
                "The model consists of individual tree models and shared links.",
            ),
        ];
        let view = model_view("What does an individual model consist of?", &refs);
        let rows = view["witnesses"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], "base");
        assert_eq!(rows[1]["role"], "Composite");
        assert!(rows.iter().all(|row| row["id"] != "other"));
        assert!(model_view(
            "How does the model process candidates?",
            &[
                reference("a", "A library is a reusable module."),
                reference("b", "A service is a process.")
            ]
        )
        .is_null());
    }

    #[test]
    fn concrete_input_and_state_operations_are_candidate_navigation_not_identity() {
        let question = "How does the model encode a variable number of candidates?";
        let plan = TargetPlan::analyze(question, &[]);
        let gap = "The mechanism for encoding candidates is not recorded.".to_owned();
        let refs = vec![
            reference("input", "We use paired candidate records as input."),
            reference(
                "state",
                "The candidate state is used to initialize the decoder.",
            ),
            reference(
                "take",
                "We take each candidate's hidden state and add a binary classification layer.",
            ),
            reference(
                "typed-operation",
                "The encoder is a recurrent network that takes as input the candidate records.",
            ),
            reference(
                "type-only",
                "The encoder is a recurrent network for candidates.",
            ),
            reference(
                "other-target",
                "The auxiliary model takes as input the candidate records.",
            ),
            reference(
                "missing",
                "The candidate input encoding operation is not recorded.",
            ),
        ];
        assert_eq!(plan.gap_scope(&gap), GapScope::ExplicitlyAsked);
        let found = plan.supplement_candidates(&[gap], &refs);
        assert_eq!(found.len(), 4);
        for row in found {
            assert!(row.reason.contains("unresolved-role-navigation"));
            let r = refs.iter().find(|r| r["id"] == row.reference_id).unwrap();
            assert_eq!(
                plan.claim_scope(&claim(r["content"].as_str().unwrap(), r), &refs),
                ClaimScope::Unresolved
            );
        }
        let count = TargetPlan::analyze("How many operators participated?", &[]);
        assert_eq!(
            count.gap_scope("The number of operators is unknown."),
            GapScope::ExplicitlyAsked
        );
        let sharing = TargetPlan::analyze("Do all decoders share weights?", &[]);
        assert_eq!(
            sharing.gap_scope("Whether the decoders share weights is unknown."),
            GapScope::ExplicitlyAsked
        );
    }
    #[test]
    fn individual_target_keeps_composite_subject_separate_from_its_objects() {
        let joint = reference(
            "j",
            "The joint model consists of individual models and shared alignment variables.",
        );
        let base = reference(
            "b",
            "We use the Cedar Bayesian model as our base monolingual model.",
        );
        let refs = vec![joint.clone(), base.clone()];
        let plan = TargetPlan::analyze("What does an individual model consist of?", &refs);
        assert_eq!(
            plan.claim_scope(
                &claim(
                    "The joint model consists of individual models and shared alignment variables.",
                    &joint
                ),
                &refs
            ),
            ClaimScope::OtherExplicitTarget
        );
        assert_eq!(
            plan.claim_scope(
                &claim(
                    "The individual model consists of shared alignment variables.",
                    &joint
                ),
                &refs
            ),
            ClaimScope::Contradiction
        );
        assert_eq!(
            plan.claim_scope(
                &claim(
                    "The individual model is based on the Cedar Bayesian model.",
                    &base
                ),
                &refs
            ),
            ClaimScope::CompatibleWitness
        );
        let view = plan.model_view();
        assert_eq!(view["witnesses"][0]["id"], "b");
        assert!(view.to_string().chars().count() <= MAX_VIEW_CHARS);
    }
    #[test]
    fn main_data_does_not_promote_an_explicit_auxiliary_or_assume_classifier_identity() {
        let auxiliary = reference(
            "a",
            "The auxiliary classifier is trained on labelled support tickets.",
        );
        let main = reference("m", "The main model is trained on transaction records.");
        let ambiguous = reference(
            "c",
            "The classifier is trained on labelled support tickets.",
        );
        let refs = vec![auxiliary.clone(), main.clone(), ambiguous.clone()];
        let plan = TargetPlan::analyze("What dataset trains the model?", &refs);
        assert_eq!(
            plan.claim_scope(
                &claim(
                    "The auxiliary classifier is trained on labelled support tickets.",
                    &auxiliary
                ),
                &refs
            ),
            ClaimScope::OtherExplicitTarget
        );
        assert_eq!(
            plan.claim_scope(
                &claim("The main model is trained on transaction records.", &main),
                &refs
            ),
            ClaimScope::CompatibleWitness
        );
        assert_eq!(
            plan.claim_scope(
                &claim(
                    "The classifier is trained on labelled support tickets.",
                    &ambiguous
                ),
                &refs
            ),
            ClaimScope::Unresolved
        );
        let explicit = TargetPlan::analyze("What dataset trains the auxiliary classifier?", &refs);
        assert_eq!(
            explicit.claim_scope(
                &claim(
                    "The auxiliary classifier is trained on labelled support tickets.",
                    &auxiliary
                ),
                &refs
            ),
            ClaimScope::CompatibleWitness
        );
    }
    #[test]
    fn gap_scope_stops_unasked_details_without_clearing_required_relations() {
        let plan = TargetPlan::analyze(
            "How does the model process a variable number of candidates?",
            &[],
        );
        for gap in [
            "Batching and padding are not specified.",
            "The tensor dimensions are unknown.",
            "Runtime complexity is not recorded.",
        ] {
            assert_eq!(plan.gap_scope(gap), GapScope::UnaskedDetail);
        }
        let asked = TargetPlan::analyze("What batching and padding strategy is used?", &[]);
        assert_eq!(
            asked.gap_scope("Batching is not recorded."),
            GapScope::ExplicitlyAsked
        );
        let shared = TargetPlan::analyze("Do the decoders share weights?", &[]);
        assert_eq!(
            shared.gap_scope("Whether weights are shared, including during batching, is unknown."),
            GapScope::ExplicitlyAsked
        );
        assert_eq!(
            shared.gap_scope("Nothing else is known."),
            GapScope::Unresolved
        );
    }
    #[test]
    fn score_does_not_require_submetrics_or_global_ranking_unless_asked() {
        let plan = TargetPlan::analyze("What is the score of the best model?", &[]);
        assert_eq!(
            plan.gap_scope("Individual scores for each metric are missing."),
            GapScope::UnaskedDetail
        );
        assert_eq!(
            plan.gap_scope("The global ranking across all studies is unknown."),
            GapScope::UnaskedDetail
        );
        let explicit =
            TargetPlan::analyze("What is its global ranking and each metric score?", &[]);
        assert_eq!(
            explicit.gap_scope("The global ranking is unknown."),
            GapScope::ExplicitlyAsked
        );
    }
    #[test]
    fn supplemental_witness_needs_a_positive_current_target_relation() {
        let main = reference("m", "The main model is trained on archived sensor data.");
        let auxiliary = reference("a", "The auxiliary model is trained on synthetic records.");
        let unknown = reference("u", "The main model training dataset is not specified.");
        let noise = reference(
            "n",
            "Training data and main model details are discussed in another section.",
        );
        let plan = TargetPlan::analyze("What dataset is used to train the model?", &[]);
        let gaps = vec![
            "The training dataset is unknown.".to_owned(),
            "Batch dimensions are unknown.".to_owned(),
        ];
        let result = plan.supplement_candidates(&gaps, &[main, auxiliary, unknown, noise]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].reference_id, "m");
        assert_eq!(result[0].gap_index, 0);
        assert_eq!(plan.supplement_queries(&gaps).len(), 1);
    }
    #[test]
    fn no_title_cooccurrence_or_uncited_body_can_create_target_support() {
        let mut wrong = reference(
            "w",
            "The joint model consists of several independent units.",
        );
        wrong["sourceTitle"] = json!("Individual model data and architecture");
        let right = reference("r", "The individual model is based on the Birch method.");
        let plan = TargetPlan::analyze(
            "What does an individual model consist of?",
            &[wrong.clone(), right.clone()],
        );
        assert_eq!(
            plan.claim_scope(
                &claim(
                    "The joint model consists of several independent units.",
                    &wrong
                ),
                &[wrong]
            ),
            ClaimScope::OtherExplicitTarget
        );
        let forged = json!({"text":"The individual model is based on Birch.","supportQuotes":[{"citationId":"absent","quote":right["content"]}]});
        assert_eq!(plan.claim_scope(&forged, &[right]), ClaimScope::Unresolved);
    }
    #[test]
    fn chinese_target_roles_and_literal_bodies_keep_direction() {
        let joint = reference("j", "联合模型由两个单语模型构成。");
        let unit = reference("u", "单体模型基于基础贝叶斯方法。");
        let refs = vec![joint.clone(), unit.clone()];
        let plan = TargetPlan::analyze("单体模型由什么构成？", &refs);
        assert_eq!(
            plan.claim_scope(&claim("联合模型由两个单语模型构成。", &joint), &refs),
            ClaimScope::OtherExplicitTarget
        );
        assert_eq!(
            plan.claim_scope(&claim("单体模型基于基础贝叶斯方法。", &unit), &refs),
            ClaimScope::CompatibleWitness
        );
    }

    #[test]
    fn approval_and_retention_are_positive_fields_but_not_owner_substitutes() {
        let question = "How long are logs retained and who approves exports?";
        let plan = TargetPlan::analyze(question, &[]);
        assert_eq!(plan.gap_scope(question), GapScope::ExplicitlyAsked);
        assert_eq!(
            plan.gap_scope("Who approves exports?"),
            GapScope::ExplicitlyAsked
        );
        let approval = reference("a", "Rina approves Boreal exports.");
        let duration = reference("d", "Boreal retains logs for 45 days.");
        let gaps = vec![
            "Who approves exports?".to_owned(),
            "The retention duration is unknown.".to_owned(),
        ];
        let witnesses = plan.supplement_candidates(&gaps, &[approval.clone(), duration]);
        assert_eq!(witnesses.len(), 2);
        assert_eq!(witnesses[0].reference_id, "a");
        assert_eq!(witnesses[0].gap_index, 0);
        assert_eq!(witnesses[1].reference_id, "d");
        assert_eq!(witnesses[1].gap_index, 1);
        let owner = TargetPlan::analyze("Who is the owner?", &[]);
        assert!(owner
            .supplement_candidates(&["The owner is unknown.".to_owned()], &[approval])
            .is_empty());
    }

    #[test]
    fn supplement_witnesses_match_the_missing_relation_not_another_asked_relation() {
        let plan = TargetPlan::analyze(
            "What dataset trains the main model and what is its deadline?",
            &[],
        );
        let training = reference("t", "The main model is trained on public sensor data.");
        let date = reference("d", "The main model deadline is 2027-03-04.");
        let gaps = vec!["The deadline is unknown.".to_owned()];
        let witnesses = plan.supplement_candidates(&gaps, &[training, date]);
        assert_eq!(witnesses.len(), 1);
        assert_eq!(witnesses[0].reference_id, "d");
    }

    #[test]
    fn unresolved_role_navigation_does_not_prove_main_identity() {
        let question = "How does the model capture sequential context?";
        let plan = TargetPlan::analyze(question, &[]);
        let body = reference(
            "u",
            "Our model uses a recurrent encoder to capture sequential context.",
        );
        let result =
            plan.supplement_candidates(&[question.to_owned()], std::slice::from_ref(&body));
        assert_eq!(result.len(), 1);
        assert!(result[0].reason.contains("unresolved-role-navigation"));
        assert_eq!(
            plan.claim_scope(
                &claim("Our model uses a recurrent encoder.", &body),
                &[body]
            ),
            ClaimScope::Unresolved
        );
    }

    #[test]
    fn long_questions_do_not_truncate_the_gap_out_of_local_queries() {
        let question = format!(
            "What dataset trains the model? {}",
            "Please preserve the project scope. ".repeat(20)
        );
        let plan = TargetPlan::analyze(&question, &[]);
        let gaps = vec![
            "The training dataset is unknown.".to_owned(),
            "The evaluation corpus is unknown.".to_owned(),
        ];
        let queries = plan.supplement_queries(&gaps);
        assert_eq!(queries.len(), 2);
        assert!(queries[0].contains("training dataset"));
        assert!(queries[1].contains("evaluation corpus"));
        assert!(queries.iter().all(|q| q.chars().count() <= 160));
    }

    #[test]
    fn multiple_targets_and_mixed_contrast_subjects_never_choose_one_by_word_priority() {
        let unit = reference("u", "The individual model is based on a Bayesian method.");
        let joint = reference(
            "j",
            "The joint model consists of several individual models.",
        );
        let refs = vec![unit.clone(), joint.clone()];
        for question in [
            "Compare the individual and joint models.",
            "Is an individual or joint model used?",
            "Compare the main model and auxiliary model training data.",
        ] {
            let plan = TargetPlan::analyze(question, &refs);
            for r in &refs {
                assert!(!matches!(
                    plan.claim_scope(&claim(r["content"].as_str().unwrap(), r), &refs),
                    ClaimScope::OtherExplicitTarget | ClaimScope::Contradiction
                ));
            }
        }
        let mixed = reference(
            "x",
            "Unlike the auxiliary classifier, the main model is trained on public records.",
        );
        let plan = TargetPlan::analyze(
            "What dataset trains the main model?",
            std::slice::from_ref(&mixed),
        );
        assert_eq!(
            plan.claim_scope(
                &claim("The main model is trained on public records.", &mixed),
                &[mixed]
            ),
            ClaimScope::Unresolved
        );
    }

    #[test]
    fn prior_work_abbreviations_and_decimal_numbers_do_not_remove_qualifiers() {
        let reference = reference(
            "p",
            "Mori et al. report that the auxiliary model is trained on 3.5 million records.",
        );
        let plan = TargetPlan::analyze("What dataset trains the main model?", &[]);
        assert!(plan
            .supplement_candidates(
                &["The training dataset is unknown.".to_owned()],
                &[reference]
            )
            .is_empty());
    }

    #[test]
    fn explicit_calculation_needs_a_concrete_method_not_an_equation_placeholder() {
        let plan = TargetPlan::analyze("How is the score calculated?", &[]);
        let gaps = vec!["The score calculation formula is unknown.".to_owned()];
        let concrete = reference(
            "formula",
            "The score is calculated by summing the weighted observations.",
        );
        let missing = reference(
            "placeholder",
            "The score is calculated by DISPLAY_EQUATION_7.",
        );
        let unresolved = reference("unknown", "The score calculation formula is not recorded.");
        assert_eq!(plan.gap_scope(&gaps[0]), GapScope::ExplicitlyAsked);
        let numeric = reference("numeric", "The score of the model is 0.7.");
        let result = plan.supplement_candidates(&gaps, &[concrete, missing, unresolved, numeric]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].reference_id, "formula");
        let retained = TargetPlan::analyze("How long are records retained?", &[]);
        assert_eq!(
            retained.gap_scope("The retention duration is unknown."),
            GapScope::ExplicitlyAsked
        );
    }

    #[test]
    fn individual_scores_or_people_do_not_create_an_individual_model_target() {
        assert_eq!(role("individual participants"), Focus::Unspecified);
        assert_eq!(role("individual scores"), Focus::Unspecified);
        assert_eq!(role("The individual model"), Focus::Unit);
        let question = "What are individual participants' scores?";
        let plan = TargetPlan::analyze(question, &[]);
        assert_eq!(plan.focus, Focus::Unspecified);
    }

    #[test]
    fn generic_data_navigation_shows_distinct_literal_functions_without_binding_main_identity() {
        let refs = vec![
            reference(
                "aux-train",
                "While training the language analyser, labelled messages are used.",
            ),
            reference(
                "origin",
                "The transaction dataset is collected from a public archive.",
            ),
            reference(
                "function",
                "The output is the following day's demand category.",
            ),
        ];
        let plan = TargetPlan::analyze("What dataset is used to train the model?", &refs);
        let view = plan.model_view();
        assert_eq!(view["identityNotInferred"], true);
        assert_eq!(view["witnesses"].as_array().unwrap().len(), 3);
        assert!(view.to_string().chars().count() <= MAX_VIEW_CHARS);
        assert!(view["witnesses"]
            .as_array()
            .unwrap()
            .iter()
            .all(|w| w["role"] == "Unspecified"));
        assert_eq!(
            plan.claim_scope(
                &claim(
                    "The language analyser is trained using labelled messages.",
                    &refs[0]
                ),
                &refs
            ),
            ClaimScope::Unresolved
        );
    }

    #[test]
    fn citing_prior_authors_or_explicitly_asking_prior_work_does_not_make_current_support_wrong() {
        let current = reference(
            "current",
            "We use the Bayesian method of Mori et al. as our base monolingual model.",
        );
        let plan = TargetPlan::analyze(
            "What does the individual model consist of?",
            std::slice::from_ref(&current),
        );
        assert_eq!(
            plan.claim_scope(
                &claim(
                    "The individual model is based on the Bayesian method of Mori.",
                    &current
                ),
                &[current]
            ),
            ClaimScope::CompatibleWitness
        );
        let previous = reference(
            "prior",
            "Previous work used an individual model that is based on a linear method.",
        );
        let prior_plan = TargetPlan::analyze(
            "What was the individual model in previous work based on?",
            std::slice::from_ref(&previous),
        );
        assert!(!matches!(
            prior_plan.claim_scope(
                &claim(
                    "The individual model in previous work is based on a linear method.",
                    &previous
                ),
                &[previous]
            ),
            ClaimScope::Contradiction | ClaimScope::OtherExplicitTarget
        ));
        let contrast = reference(
            "contrast",
            "Unlike previous work, the main model is trained on archived records.",
        );
        let plan = TargetPlan::analyze(
            "What dataset trains the main model?",
            std::slice::from_ref(&contrast),
        );
        assert_eq!(
            plan.claim_scope(
                &claim("The main model is trained on archived records.", &contrast),
                &[contrast]
            ),
            ClaimScope::CompatibleWitness
        );
        let citation = reference(
            "citation",
            "The individual model is based on the method of Mori et al.",
        );
        let plan = TargetPlan::analyze(
            "What is the individual model based on?",
            std::slice::from_ref(&citation),
        );
        assert_eq!(
            plan.claim_scope(
                &claim(citation["content"].as_str().unwrap(), &citation),
                std::slice::from_ref(&citation)
            ),
            ClaimScope::CompatibleWitness
        );
    }

    #[test]
    fn a_comparison_baseline_can_be_a_different_model_level() {
        let baseline = reference("b", "The joint model is the comparison baseline.");
        let plan = TargetPlan::analyze(
            "Which baseline is used for the individual model?",
            std::slice::from_ref(&baseline),
        );
        assert_eq!(
            plan.claim_scope(
                &claim("The joint model is the comparison baseline.", &baseline),
                std::slice::from_ref(&baseline)
            ),
            ClaimScope::Unresolved
        );
        let compare = TargetPlan::analyze(
            "Compare the individual model with the approach in the appendix.",
            std::slice::from_ref(&baseline),
        );
        assert_eq!(
            compare.claim_scope(
                &claim("The joint model is the comparison baseline.", &baseline),
                std::slice::from_ref(&baseline)
            ),
            ClaimScope::Unresolved
        );
        let prior = reference(
            "p",
            "Previous work used an individual model that is based on a linear method.",
        );
        let plan = TargetPlan::analyze(
            "What does an individual model consist of?",
            std::slice::from_ref(&prior),
        );
        assert_eq!(
            plan.claim_scope(
                &claim(
                    "The individual model in previous work is based on a linear method.",
                    &prior
                ),
                &[prior]
            ),
            ClaimScope::OtherExplicitTarget
        );
    }

    #[test]
    fn an_explicit_scope_bound_name_is_not_overridden_by_generic_main_intent() {
        let mut named = reference(
            "named",
            "The auxiliary Cedar model is trained on labelled messages.",
        );
        named["facets"] = json!({"entity":"Cedar"});
        let plan = TargetPlan::analyze(
            "What dataset trains the Cedar model?",
            std::slice::from_ref(&named),
        );
        assert_eq!(
            plan.claim_scope(
                &claim(named["content"].as_str().unwrap(), &named),
                std::slice::from_ref(&named)
            ),
            ClaimScope::CompatibleWitness
        );
        let generic = TargetPlan::analyze(
            "What dataset trains the model?",
            std::slice::from_ref(&named),
        );
        assert_eq!(
            generic.claim_scope(
                &claim(named["content"].as_str().unwrap(), &named),
                std::slice::from_ref(&named)
            ),
            ClaimScope::OtherExplicitTarget
        );
        let explicit_main = TargetPlan::analyze(
            "What dataset trains the main Cedar model?",
            std::slice::from_ref(&named),
        );
        assert_eq!(
            explicit_main.claim_scope(&claim(named["content"].as_str().unwrap(), &named), &[named]),
            ClaimScope::OtherExplicitTarget
        );
        assert_eq!(
            role("The main result for the Cedar model"),
            Focus::Unspecified
        );
    }

    #[test]
    fn compound_formula_and_numeric_score_keep_both_orders_without_using_numeric_for_formula() {
        for question in [
            "What is the formula and what is the score?",
            "What is the score and what is its formula?",
        ] {
            let plan = TargetPlan::analyze(question, &[]);
            assert!(plan.relations.contains(&Relation::Metric));
            assert!(plan.relations.contains(&Relation::Calculation));
            let numeric = reference("n", "The score of the model is 0.7.");
            let method = reference(
                "f",
                "The score is calculated by summing weighted observations.",
            );
            let formula_gap = vec!["The score calculation formula is unknown.".to_owned()];
            let witnesses = plan.supplement_candidates(&formula_gap, &[numeric.clone(), method]);
            assert_eq!(witnesses.len(), 1);
            assert_eq!(witnesses[0].reference_id, "f");
            let numeric_gap = vec!["The numeric score is unknown.".to_owned()];
            assert_eq!(
                plan.supplement_candidates(&numeric_gap, &[numeric]).len(),
                1
            );
        }
    }
}
