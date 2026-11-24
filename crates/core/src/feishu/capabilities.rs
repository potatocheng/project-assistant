//! Capability-level permission model for personal-account Feishu integration.
//!
//! Application registration still requests all 9 target scopes upfront. Once the
//! app has any subset approved by the tenant, personal OAuth requests only the
//! approved subset (plus `offline_access`), enabling matching features while
//! pausing unapproved ones until admin approval and incremental user consent.
use super::*;
use std::collections::BTreeSet;

pub(super) const BASE_SCOPE: &str = "offline_access";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(super) enum Capability {
    DocxSync,
    WikiSync,
    ChatList,
    GroupSync,
    GroupReply,
    P2pReply,
}

pub(super) const ALL_CAPABILITIES: &[Capability] = &[
    Capability::DocxSync,
    Capability::WikiSync,
    Capability::ChatList,
    Capability::GroupSync,
    Capability::GroupReply,
    Capability::P2pReply,
];

impl Capability {
    pub(super) const fn id(self) -> &'static str {
        match self {
            Self::DocxSync => "docx_sync",
            Self::WikiSync => "wiki_sync",
            Self::ChatList => "chat_list",
            Self::GroupSync => "group_sync",
            Self::GroupReply => "group_reply",
            Self::P2pReply => "p2p_reply",
        }
    }

    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::DocxSync => "飞书文档采集",
            Self::WikiSync => "飞书知识库采集",
            Self::ChatList => "读取群列表",
            Self::GroupSync => "飞书群消息采集",
            Self::GroupReply => "群聊 @提问自动代答",
            Self::P2pReply => "同事私聊自动代答",
        }
    }

    pub(super) const fn description(self) -> &'static str {
        match self {
            Self::DocxSync => "在记忆中心同步新版飞书文档（/docx/）正文",
            Self::WikiSync => "在记忆中心同步飞书知识库（/wiki/）新版文档",
            Self::ChatList => "自动拉取可访问的群列表供选择（缺此权限仍可手动填群 ID）",
            Self::GroupSync => "在记忆中心增量采集指定飞书群的消息与话题",
            Self::GroupReply => "在已绑定群聊中以你的身份自动回复 @提问",
            Self::P2pReply => "读取最近私聊并自动回复已绑定同事的私聊消息",
        }
    }

    pub(super) const fn required_scopes(self) -> &'static [&'static str] {
        match self {
            Self::DocxSync => &["docx:document:readonly"],
            Self::WikiSync => &["wiki:wiki:readonly", "docx:document:readonly"],
            Self::ChatList => &["im:chat:read"],
            Self::GroupSync => &[
                "im:message.group_msg:get_as_user",
                "im:message",
                "search:message",
            ],
            Self::GroupReply => &[
                "search:message",
                "im:message.group_msg:get_as_user",
                "im:message",
                "im:message.send_as_user",
            ],
            Self::P2pReply => &[
                "search:message",
                "im:message.p2p_msg:get_as_user",
                "im:message",
                "im:chat:read",
                "im:message.send_as_user",
            ],
        }
    }

    pub(super) fn is_satisfied_by(self, scopes: &HashSet<String>) -> bool {
        self.required_scopes()
            .iter()
            .all(|scope| scopes.contains(*scope))
    }

    pub(super) fn missing_from<'a>(self, scopes: &HashSet<String>) -> Vec<&'a str> {
        self.required_scopes()
            .iter()
            .copied()
            .filter(|scope| !scopes.contains(*scope))
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PermissionNotification {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub message: String,
    pub capability_ids: Vec<String>,
    pub created_at: String,
}

pub(super) fn parse_scope_set(raw: &str) -> HashSet<String> {
    raw.split_whitespace().map(str::to_owned).collect()
}

pub(super) fn target_scopes() -> Vec<&'static str> {
    SCOPES.split_whitespace().collect()
}

pub(super) fn business_scopes() -> Vec<&'static str> {
    SCOPES
        .split_whitespace()
        .filter(|scope| *scope != BASE_SCOPE)
        .collect()
}

pub(super) fn has_all_business_scopes(scopes: &HashSet<String>) -> bool {
    business_scopes().iter().all(|s| scopes.contains(*s))
}

/// Computes the exact `scope` parameter for `/open-apis/authen/v1/authorize`.
///
/// When we know which app-level scopes are already approved by the tenant, we
/// intersect them with our target business scopes and always include
/// `offline_access` so Feishu OAuth never rejects the request with error 20027.
/// When app scope status is unknown, we fall back to requesting all `SCOPES`.
pub(super) fn oauth_scope_string(approved_app_scopes: Option<&HashSet<String>>) -> String {
    let Some(approved) = approved_app_scopes else {
        return SCOPES.to_owned();
    };
    let mut selected = vec![BASE_SCOPE];
    for scope in business_scopes() {
        if approved.contains(scope) {
            selected.push(scope);
        }
    }
    selected.join(" ")
}

/// Parses `GET /open-apis/application/v6/scopes` response data into the set of
/// approved user-applicable scopes (`grant_status == 1`, excluding tenant-only).
pub(super) fn parse_app_scopes_response(data: &Value) -> Result<HashSet<String>> {
    let items = data["scopes"]
        .as_array()
        .ok_or_else(|| error("FEISHU_RESPONSE", "飞书权限状态响应缺少 scopes 列表"))?;
    let mut approved = HashSet::new();
    for item in items {
        let Some(name) = item["scope_name"]
            .as_str()
            .or_else(|| item["scope"].as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let granted =
            item["grant_status"].as_i64() == Some(1) || item["grant_status"].as_str() == Some("1");
        if !granted {
            continue;
        }
        if item["scope_type"]
            .as_str()
            .is_some_and(|kind| kind.eq_ignore_ascii_case("tenant"))
        {
            continue;
        }
        approved.insert(name.to_owned());
    }
    Ok(approved)
}

pub(super) fn enabled_capabilities(
    connected: bool,
    granted: &HashSet<String>,
) -> BTreeSet<Capability> {
    if !connected {
        return BTreeSet::new();
    }
    ALL_CAPABILITIES
        .iter()
        .copied()
        .filter(|cap| cap.is_satisfied_by(granted))
        .collect()
}

pub(super) fn ready_to_confirm_capabilities(
    connected: bool,
    granted: &HashSet<String>,
    approved_app: Option<&HashSet<String>>,
) -> BTreeSet<Capability> {
    let Some(approved) = approved_app else {
        return BTreeSet::new();
    };
    ALL_CAPABILITIES
        .iter()
        .copied()
        .filter(|cap| {
            let already_enabled = connected && cap.is_satisfied_by(granted);
            !already_enabled && cap.is_satisfied_by(approved)
        })
        .collect()
}

pub(super) fn capability_status(
    cap: Capability,
    connected: bool,
    granted: &HashSet<String>,
    approved_app: Option<&HashSet<String>>,
) -> &'static str {
    if connected && cap.is_satisfied_by(granted) {
        return "enabled";
    }
    if let Some(approved) = approved_app {
        if cap.is_satisfied_by(approved) {
            return "ready_to_confirm";
        }
        return "pending_approval";
    }
    "unavailable"
}

pub(super) fn format_missing_permission_message(
    cap: Capability,
    granted: &HashSet<String>,
    approved_app: Option<&HashSet<String>>,
) -> String {
    let missing = cap.missing_from(granted);
    let scopes = missing.join("、");
    if approved_app.is_some_and(|approved| cap.is_satisfied_by(approved)) {
        format!(
            "「{}」权限已在飞书获批，请到「飞书助理 → 连接账号」点击一键补充个人确认后自动启用（待确认：{}）",
            cap.label(),
            scopes
        )
    } else {
        format!(
            "「{}」暂未开启：缺少权限 {}，等待飞书管理员审批通过后即可启用",
            cap.label(),
            scopes
        )
    }
}

pub(super) fn build_permissions_snapshot(
    connected: bool,
    granted: &HashSet<String>,
    approved_app: Option<&HashSet<String>>,
    last_checked_at: Option<&str>,
    last_check_error: Option<&str>,
    notifications: &[PermissionNotification],
) -> Value {
    let targets = target_scopes();
    let granted_list: Vec<&str> = if connected {
        targets
            .iter()
            .copied()
            .filter(|s| granted.contains(*s))
            .collect()
    } else {
        Vec::new()
    };
    let approved_list: Option<Vec<&str>> = approved_app.map(|approved| {
        targets
            .iter()
            .copied()
            .filter(|s| *s == BASE_SCOPE || approved.contains(*s))
            .collect()
    });
    let pending_approval_scopes: Vec<&str> = match approved_app {
        Some(approved) => business_scopes()
            .into_iter()
            .filter(|s| !approved.contains(*s))
            .collect(),
        None => Vec::new(),
    };
    let newly_approved_scopes: Vec<&str> = match approved_app {
        Some(approved) => business_scopes()
            .into_iter()
            .filter(|s| approved.contains(*s) && (!connected || !granted.contains(*s)))
            .collect(),
        None => Vec::new(),
    };
    let capabilities: Vec<Value> = ALL_CAPABILITIES
        .iter()
        .copied()
        .map(|cap| {
            let status = capability_status(cap, connected, granted, approved_app);
            let missing: Vec<&str> = if connected {
                cap.missing_from(granted)
            } else {
                cap.required_scopes().to_vec()
            };
            let pending_app: Vec<&str> = match approved_app {
                Some(approved) => cap.missing_from(approved),
                None => Vec::new(),
            };
            let ready_scopes: Vec<&str> = match approved_app {
                Some(approved) => missing
                    .iter()
                    .copied()
                    .filter(|s| approved.contains(*s))
                    .collect(),
                None => Vec::new(),
            };
            json!({
                "id": cap.id(),
                "label": cap.label(),
                "description": cap.description(),
                "status": status,
                "requiredScopes": cap.required_scopes(),
                "missingScopes": missing,
                "pendingApprovalScopes": pending_app,
                "readyToConfirmScopes": ready_scopes,
            })
        })
        .collect();
    json!({
        "targetScopes": targets,
        "grantedScopes": granted_list,
        "approvedAppScopes": approved_list,
        "pendingApprovalScopes": pending_approval_scopes,
        "newlyApprovedScopes": newly_approved_scopes,
        "lastCheckedAt": last_checked_at,
        "lastCheckError": last_check_error,
        "capabilities": capabilities,
        "notifications": notifications,
    })
}
