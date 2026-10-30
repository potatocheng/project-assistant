use serde_json::{json, Value};
pub fn bound(text: &str, ids: Value, quote: &str) -> Value {
    let anchors = ids
        .as_array()
        .unwrap()
        .iter()
        .map(|id| json!({"citationId":id,"quote":quote.chars().take(600).collect::<String>()}))
        .collect::<Vec<_>>();
    json!({"grounded":true,"answer":"","citationIds":ids,"status":"answered","unknowns":[],"claims":[{"text":text,"citationIds":ids,"supportQuotes":anchors}]})
}
