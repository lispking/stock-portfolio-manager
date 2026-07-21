use serde::{Deserialize, Serialize};

/// Where a skill file originates from. Built-in skills are shipped with the
/// app (embedded via `include_str!`) and materialised into the user skills
/// directory on first launch; the user can then edit or delete the copies.
/// User marks anything the user created or modified themselves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
    Builtin,
    User,
}

/// A single AI assistant skill — a Markdown document with YAML-ish
/// frontmatter (`name` / `description` / `trigger` / `enabled`) whose body is
/// the instruction text appended to the system prompt when the skill is
/// activated.
///
/// `id` is the file stem (kebab-case) and the stable identity used to refer
/// to a skill from the chat UI and from `active_skills` in `ChatParams`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    /// File stem, e.g. `portfolio-risk-analysis`. Stable identity.
    pub id: String,
    /// Human-readable name from frontmatter; falls back to `id`.
    pub name: String,
    /// Short one-line description shown in UI chips and used for auto-match
    /// hints.
    pub description: String,
    /// Comma-separated keywords (parsed from frontmatter) that trigger
    /// automatic activation when they appear in the latest user message.
    #[serde(default)]
    pub trigger: Vec<String>,
    /// Whether the skill participates in auto-activation. Explicit `/` or
    /// `@` invocation ignores this flag.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// The Markdown body — the actual instructions appended to the system
    /// prompt when the skill activates.
    pub content: String,
    /// Whether this row came from the built-in bundle or was created/edited
    /// by the user.
    pub source: SkillSource,
    /// Last modification time of the underlying file (RFC3339).
    pub updated_at: String,
}

fn default_enabled() -> bool {
    true
}
