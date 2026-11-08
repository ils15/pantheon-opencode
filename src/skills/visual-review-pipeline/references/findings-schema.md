# Visual Review Pipeline — Findings Schema Detail

Detail companion for `SKILL.md`. Read on demand when classifying issues or
grading severity. The findings JSON structure itself, the loop contract,
iteration rules, and escalation triggers stay in `SKILL.md`.

---

## Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `verdict` | enum | `pass` = no issues, `fail` = blocking, `warn` = non-blocking |
| `iteration` | int | Current iteration number (1-3) |
| `max_iterations` | int | Always 3 |
| `issues` | array | List of visual issues found |
| `issues[].id` | string | Unique ID in format `VIS-NNN` |
| `issues[].category` | enum | Issue category (see Categories) |
| `issues[].severity` | enum | Severity level (see Severity) |
| `issues[].description` | string | Clear description of the issue |
| `issues[].screenshot_region` | string | Bounding box or region reference |
| `issues[].recommendation` | string | Suggested fix |
| `summary` | string | One-line overall assessment |
| `pass_if_fixed` | string[] | Issue IDs that must be resolved to pass |

---

## Categories

| Category | Description | Examples |
|----------|-------------|---------|
| `layout` | Positioning, alignment, overflow | Element misplaced, container overflow, z-index issues |
| `contrast` | Color contrast, visibility | Text hard to read, low contrast ratio |
| `responsive` | Mobile/tablet behavior | Elements break at specific breakpoints |
| `missing_element` | Expected element not rendered | Button not visible, icon missing |
| `typography` | Font, size, weight, spacing | Wrong font family, text truncation |
| `spacing` | Margins, padding, gaps | Uneven spacing, cramped elements |
| `accessibility` | ARIA, focus states, keyboard nav | Missing alt text, no focus ring |

---

## Severity Levels

| Level | Description | Action Required |
|-------|-------------|-----------------|
| `critical` | Blocks user interaction or content | Must fix before merge |
| `high` | Significant visual regression | Must fix before merge |
| `medium` | Noticeable but not blocking | Fix in current sprint |
| `low` | Minor polish item | Backlog, fix when convenient |
