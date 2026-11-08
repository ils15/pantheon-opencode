# Session Goal — Format Template and Example

Detail companion for `SKILL.md`. Read on demand when pinning a goal and you
need the full template or a worked example. The alignment check and the
persistence guardrails stay in `SKILL.md`.

---

## Goal Format

A good session goal has 4 components:

```
GOAL: <What to build>
SCOPE: <Which layers/modules are in scope>
SUCCESS CRITERIA: <How we know it's done>
OUT OF SCOPE: <What to explicitly exclude>
```

**Example:**
```
GOAL: Add email verification to the registration flow
SCOPE: Backend (POST /auth/verify, token model), Frontend (VerifyEmail page), DB (verification_tokens table)
SUCCESS CRITERIA: User can register, receive a verification email link, click it, and have their account marked as verified. All layers tested >80% coverage.
OUT OF SCOPE: Password reset, 2FA, email template design
```
