//! A question-only contract shared by generation and review. Neither answers,
//! unknowns nor retrieved records may manufacture additional obligations.
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub(crate) struct QuestionPlan {
    targets: Vec<String>,
}

impl QuestionPlan {
    pub(crate) fn from_question(question: &str) -> Self {
        let question = question.trim();
        // Split only an explicit second interrogative. In particular, lists of
        // models, datasets, features, dimensions and examples stay one target.
        let separators = [
            " and who ",
            " and what ",
            " and which ",
            " and how ",
            " and when ",
            " and where ",
            " and why ",
            "; who ",
            "; what ",
            "; which ",
            "; how ",
            "; when ",
            "; where ",
            "; why ",
            "以及谁",
            "以及什么",
            "以及哪些",
            "以及如何",
            "以及何时",
            "以及哪里",
            "并且谁",
            "并且如何",
            "，谁",
            "，如何",
            "，什么时候",
            "？谁",
            "？如何",
            "? who ",
            "? what ",
            "? how ",
            "? which ",
            "? when ",
            "? where ",
            "? why ",
            "? is ",
            "? are ",
            "? does ",
            "? do ",
            "? can ",
            "? will ",
            "? was ",
            "? were ",
            "? has ",
            "? have ",
            "? should ",
            "？是否",
            "？能否",
        ];
        let lower = question.to_lowercase();
        let mut cuts = Vec::new();
        // ASCII case changes preserve byte offsets; non-ASCII alphabetic
        // case changes need not. Fall back to one complete original question.
        if lower.len() == question.len() {
            for separator in separators {
                for (at, _) in lower.match_indices(separator) {
                    let keep = if separator.starts_with(" and ") {
                        5
                    } else if separator.starts_with("; ") || separator.starts_with("? ") {
                        2
                    } else if separator.starts_with("以及") || separator.starts_with("并且") {
                        6
                    } else {
                        separator.chars().next().unwrap().len_utf8()
                    };
                    cuts.push((at, at + keep));
                }
            }
        }
        cuts.sort_unstable();
        cuts.dedup();
        let mut targets = Vec::new();
        let mut start = 0;
        for (end, next) in cuts {
            if end >= start && question.is_char_boundary(end) && question.is_char_boundary(next) {
                let target = question[start..end].trim();
                if !target.is_empty() {
                    targets.push(target.to_owned());
                }
                start = next;
            }
        }
        let tail = question[start..].trim();
        if !tail.is_empty() {
            targets.push(tail.to_owned());
        }
        // Preserve all asked content when a question exceeds the bounded
        // number of rows. Never silently truncate the seventh obligation.
        if targets.is_empty() || targets.len() > 6 {
            targets = vec![question.to_owned()];
        }
        Self { targets }
    }

    pub(crate) fn model_view(&self) -> Value {
        json!({"version":"question-only-obligations-v3-answer-focus","source":"original-question-only",
            "obligations":self.targets.iter().enumerate().map(|(index,target)|
                json!({"obligationId":format!("o{}",index+1),"target":target,
                    "granularity":requested_granularity(target)})).collect::<Vec<_>>()})
    }

    pub(crate) fn targets(&self) -> &[String] {
        &self.targets
    }

    pub(crate) fn obligation_ids(&self) -> Vec<String> {
        (1..=self.targets.len())
            .map(|index| format!("o{index}"))
            .collect()
    }
}

/// These labels constrain answer scope, never establish a fact or decide that
/// a missing field has been answered. Explicit scope always survives intact.
fn requested_granularity(question: &str) -> Value {
    let lower = question.to_lowercase();
    let words = lower
        .split(|c: char| !c.is_alphanumeric())
        .collect::<Vec<_>>();
    let any = |terms: &[&str]| terms.iter().any(|term| words.contains(term));
    let chinese = |terms: &[&str]| terms.iter().any(|term| lower.contains(term));
    let count = lower.contains("how many")
        || ["what number", "what is the number", "what was the number"]
            .iter()
            .any(|prefix| lower.starts_with(prefix))
        || chinese(&["多少人", "几名", "几位", "多少个", "几个", "数量是多少"]);
    let quantity = ["how long", "how much", "how often", "how far", "how old"]
        .iter()
        .any(|prefix| lower.starts_with(prefix));
    let mechanism =
        !count && !quantity && (lower.starts_with("how ") || chinese(&["如何", "怎么", "机制"]));
    let composition = any(&[
        "consist",
        "consists",
        "composition",
        "composed",
        "components",
        "architecture",
    ]) || chinese(&["组成", "构成", "架构"]);
    let mut question_words = words.iter().copied().filter(|word| !word.is_empty());
    let mut head = question_words.next();
    while head.is_some_and(|word| ["overall", "generally", "usually", "typically"].contains(&word))
    {
        head = question_words.next();
    }
    if head == Some("in") && question_words.next() == Some("general") {
        head = question_words.next();
    }
    let yes_no = head.is_some_and(|word| {
        [
            "is", "are", "do", "does", "did", "can", "will", "was", "were", "has", "have", "would",
            "should",
        ]
        .contains(&word)
    }) || chinese(&["是否", "是不是", "有没有", "能否", "会不会"]);
    let survey = [
        "state of the art",
        "state-of-the-art",
        "related work",
        "survey",
        "overview",
        "综述",
        "研究现状",
        "相关工作",
    ]
    .iter()
    .any(|term| lower.contains(term));
    let form = if count {
        "scoped_count"
    } else if mechanism {
        "documented_process"
    } else if yes_no {
        "yes_no"
    } else if survey {
        "survey_summary"
    } else if composition {
        "composition_summary"
    } else {
        "direct_fact"
    };
    let mut explicit = Vec::new();
    if any(&[
        "all",
        "every",
        "entire",
        "full",
        "complete",
        "total",
        "exhaustive",
    ]) || chinese(&["全部", "所有", "完整", "总体人数", "总人数", "总数", "整个"])
    {
        explicit.push("exhaustive");
    }
    if any(&[
        "internal",
        "internals",
        "implementation",
        "padding",
        "batching",
        "dimension",
        "dimensions",
    ]) || chinese(&["内部", "填充", "批处理", "维度", "实现细节"])
    {
        explicit.push("implementation");
    }
    if any(&[
        "baseline",
        "relative",
        "compare",
        "compared",
        "comparison",
        "sharing",
        "shared",
        "weights",
        "formula",
        "calculate",
        "computed",
    ]) || chinese(&["基线", "相比", "比较", "共享", "权重", "公式", "计算"])
    {
        explicit.push("relation");
    }
    if any(&["separately", "separate", "individually"])
        || chinese(&["分别训练", "单独训练", "独立训练", "每一阶段", "每个步骤"])
        || mechanism && (any(&["pretraining", "pretrained"]) || chinese(&["预训练"]))
    {
        explicit.push("separate");
    }
    if any(&["submetrics", "breakdown"])
        || [
            "each score",
            "individual scores",
            "separate scores",
            "each metric",
        ]
        .iter()
        .any(|phrase| lower.contains(phrase))
        || chinese(&["分项指标", "各项分数", "各子指标", "每项指标"])
    {
        explicit.push("breakdown");
    }
    let mut granularity = json!({"form":form,"explicitScope":explicit});
    // Question-derived guidance is separate from evidence: it chooses what a
    // sourced answer should address, never supplies a value or approves it.
    if form == "scoped_count" {
        granularity["answerFocus"] = json!(if explicit.contains(&"exhaustive") {
            "The requested total population. A subgroup count alone cannot complete this obligation."
        } else {
            "Lead with the recorded count of the requested participant/item role and name its cohort or phase. Do not replace that count with an unspecified wider population total, or mix counts for other roles/phases into the primary answer."
        });
        granularity["completionCheck"] = json!(if explicit.contains(&"exhaustive") {
            "Verify the documented count covers the explicitly requested whole population; otherwise preserve that missing total."
        } else {
            "A supported count with its actual group/condition can complete this scoped question. An absent total for a different or broader phase is unasked. If multiple equally applicable counts really conflict, preserve their distinct scopes instead of inventing one number."
        });
    }
    if form == "composition_summary" {
        granularity["answerFocus"] = json!("Describe the requested unit itself, using its explicit base/component relation. A larger system containing that unit is background, not the unit's composition. Preserve supported base identity; do not require unasked internal decomposition.");
    }
    if form == "documented_process" {
        granularity["answerFocus"] = json!("Explain the documented causal/operational chain: input preparation, operation and output/selection, where each is recorded and relevant. Preserve variable cardinality and conditions. Merely listing an architecture name is not the process.");
        if !explicit.contains(&"implementation") {
            granularity["completionCheck"] = json!("Judge the requested mechanism using its recorded operations. Do not add padding, batching, dimensions or other implementation requirements solely because the question asks how. Preserve any genuinely missing asked relation.");
        }
    }
    if form == "survey_summary" {
        granularity["scope"] = json!(if explicit.contains(&"exhaustive") {
            "requested_exhaustive"
        } else {
            "source_representatives"
        });
        granularity["answerFocus"] = json!("Summarize the source's representative prior approaches with their distinguishing method, role or reported finding when documented. Names and dates alone may omit the substance. The authors' own proposal is not a substitute for the reviewed approaches. Do not require every detail or an external worldwide inventory.");
    }
    granularity
}

pub(crate) fn claim_id(index: usize) -> String {
    format!("c{}", index + 1)
}
pub(crate) fn unknown_id(index: usize) -> String {
    format!("u{}", index + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_interrogatives_split_but_lists_and_implementation_details_do_not() {
        let plan = QuestionPlan::from_question(
            "How long does Atlas retain logs and who approves exports?",
        );
        assert_eq!(
            plan.targets(),
            &["How long does Atlas retain logs", "who approves exports?"]
        );
        for question in [
            "Which models and datasets are used?",
            "How is a variable number of items handled?",
            "主任务模型使用什么数据集和指标？",
        ] {
            assert_eq!(QuestionPlan::from_question(question).targets(), &[question]);
        }
    }

    #[test]
    fn chinese_second_questions_preserve_all_original_asked_content() {
        let plan = QuestionPlan::from_question("日志保留多久，以及谁批准导出？");
        assert_eq!(plan.targets(), &["日志保留多久，", "谁批准导出？"]);
        assert_eq!(plan.obligation_ids(), vec!["o1", "o2"]);
    }

    #[test]
    fn excess_obligations_are_grouped_without_losing_question_content() {
        let question = "what is A and who is B and how is C and when is D and where is E and why is F and which is G?";
        assert_eq!(QuestionPlan::from_question(question).targets(), &[question]);
        assert_eq!(claim_id(0), "c1");
        assert_eq!(unknown_id(3), "u4");
    }

    #[test]
    fn question_granularity_does_not_invent_exhaustive_or_internal_requirements() {
        for (question, form) in [
            ("How many reviewers participated?", "scoped_count"),
            (
                "How does the processor handle a varying number of items?",
                "documented_process",
            ),
            ("What does the component consist of?", "composition_summary"),
        ] {
            let view = QuestionPlan::from_question(question).model_view();
            assert_eq!(view["obligations"][0]["granularity"]["form"], form);
            assert_eq!(
                view["obligations"][0]["granularity"]["explicitScope"],
                json!([])
            );
            assert!(view.get("policy").is_none());
        }
    }

    #[test]
    fn explicit_exhaustive_implementation_and_relational_questions_preserve_their_scope() {
        for question in [
            "How many reviewers participated in the entire study?",
            "全部参与者的总人数是多少？",
        ] {
            assert!(requested_granularity(question)["explicitScope"]
                .as_array()
                .unwrap()
                .contains(&json!("exhaustive")));
        }
        for question in [
            "How does internal padding handle every item?",
            "完整架构的内部维度如何设置？",
        ] {
            let scope = requested_granularity(question);
            assert!(scope["explicitScope"]
                .as_array()
                .unwrap()
                .contains(&json!("implementation")));
            assert!(scope["explicitScope"]
                .as_array()
                .unwrap()
                .contains(&json!("exhaustive")));
        }
        assert!(
            requested_granularity("Do all components have the same weights?")["explicitScope"]
                .as_array()
                .unwrap()
                .contains(&json!("relation"))
        );
        assert!(
            requested_granularity("What model handles a small collection?")["explicitScope"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_second_yes_no_question_is_a_fixed_obligation_not_an_invented_training_phase() {
        for question in [
            "Which pretrained model is used?",
            "Is the encoder pretrained?",
            "编码器是否经过预训练？",
        ] {
            assert!(!requested_granularity(question)["explicitScope"]
                .as_array()
                .unwrap()
                .contains(&json!("separate")));
        }
        assert_eq!(
            requested_granularity("What is the state of the art described here?")["form"],
            "survey_summary"
        );
        assert_eq!(
            requested_granularity("Overall, does the approach improve performance?")["form"],
            "yes_no"
        );
        assert_eq!(
            requested_granularity("In general, is the effect significant?")["form"],
            "yes_no"
        );
        let plan =
            QuestionPlan::from_question("How are the components trained? Is training end-to-end?");
        assert_eq!(
            plan.targets(),
            &["How are the components trained", "Is training end-to-end?"]
        );
        let view = plan.model_view();
        assert_eq!(
            view["obligations"][0]["granularity"]["form"],
            "documented_process"
        );
        assert_eq!(view["obligations"][1]["granularity"]["form"], "yes_no");
        assert!(view["obligations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["granularity"]["explicitScope"]
                .as_array()
                .unwrap()
                .is_empty()));
        assert!(
            requested_granularity("How are the modules separately pretrained?")["explicitScope"]
                .as_array()
                .unwrap()
                .contains(&json!("separate"))
        );
        assert!(
            requested_granularity("What is the score of each metric?")["explicitScope"]
                .as_array()
                .unwrap()
                .contains(&json!("breakdown"))
        );
    }

    #[test]
    fn a_source_survey_summary_is_representative_unless_exhaustiveness_was_explicitly_requested() {
        for question in [
            "What is the state of the art described in the source?",
            "概括文中的研究现状。",
        ] {
            let scope = requested_granularity(question);
            assert_eq!(scope["form"], "survey_summary");
            assert_eq!(scope["scope"], "source_representatives");
            assert_eq!(scope["explicitScope"], json!([]));
        }
        for question in [
            "List the complete survey of all described methods.",
            "列出文中综述的全部系统。",
        ] {
            assert_eq!(
                requested_granularity(question)["scope"],
                "requested_exhaustive"
            );
        }
        assert!(requested_granularity("Which model is used?")
            .get("scope")
            .is_none());
    }
}
