# Web UI

The UI follows the product spec `SignalFlow_IR_UI_UX_Product_Spec.md` (P0 scope), adapted to this backend.
It is a Vite + React single-page app in `apps/web`, with `react-router-dom` for the routes below.
All screens run against the same API in the three run modes (demo personas, Compose with Keycloak, Azure with Entra ID).

## Routes

| Route | Who | What |
|---|---|---|
| `/login` | everyone | OIDC button, or the persona picker in demo mode |
| `/app/overview` | signed in | KPIs, "needs your attention" queue, pipeline, recent activity |
| `/app/announcements` | signed in | filterable list (state, jurisdiction, headline search), next step per row |
| `/app/announcements/new`, `/:id/edit` | author | four-step composer: Details, Content, Validate, Preview |
| `/app/announcements/:id` | signed in | content, actions, revision diff, approvals, publication receipt, timeline, AI pre-check |
| `/app/announcements/:id/review`, `/app/review` | approver roles | side-by-side review room; inbox of what waits for you |
| `/app/publishing` | publisher | KPI strip, ready list, deliveries table with detail drawer, mock-wire controls (demo) |
| `/app/activity`, `/app/workspace` | signed in | company activity; read-only people, identifiers, rules, runtime |
| `/public/announcements`, `/:id` | nobody needs to sign in | published announcements only, with the demonstration disclaimer |

The server stays the authority: screens hide what a role cannot do, and the API refuses it anyway.
Public routes call `/api/public/*`, which returns no people, approvals or jurisdiction metadata.

## Where the code deviates from the spec

| Spec | Here | Why |
|---|---|---|
| Roles Editor / Reviewer / Publisher / Admin | Editor = `author`; Reviewer = `company_secretary`, `legal` or `cfo`; Publisher = `publisher`; **no Admin** | The backend has no admin role. Workspace is read-only for everyone; people and roles live in the identity provider |
| Email + password login | OIDC redirect (Keycloak, Entra ID) or demo persona picker | Passwords are the identity provider's job; the app never sees them |
| "Needs reconciliation" status | Shown as **Retrying**; Failed copy says "Retry will first check whether the provider already accepted it" | The worker looks the filing up before every attempt, so reconciliation is automatic and has no separate state |
| Receipts | Real-format references, always labelled **Published · Demo** | Never a bare "Published" while the wire is a mock |
| Field-anchored validation links | Issues list with the field path | The server reports a path, not a DOM anchor |
| Company Pulse / watchlist (P1/P2) | Not built | Out of the chosen scope |

## Behaviours worth knowing

- **Composer state lives in the URL** (`?step=`), and the saved draft is reloaded from the server, so a refresh or the first save never loses the step. Changing jurisdiction (or category with details filled in) asks for confirmation because the jurisdiction-specific details are cleared.
- **Maker-checker in the UI:** Approve is disabled with a sentence of explanation for the author of the revision and for someone who already approved it; Request changes needs a reason; Approve and Publish ask for confirmation.
- **Diff** is word-level (`src/diff.ts`), computed in the browser from `/revisions`.
- **Accessibility:** state is icon plus text, never colour alone; native `<dialog>` gives focus trapping and Escape; `prefers-reduced-motion` is honoured; skip link; layouts verified down to 400 px without horizontal scroll.
- **Polling:** the list refreshes every 4 s while the tab is visible; publishing screens every 1.5 to 3 s while something is in flight.

## Tests and checks

`npm test -w apps/web` covers the pure logic (diff, attention queue, required-field readiness). The screens were driven by hand in a browser:
UK journey (compose, validate, preview, submit, approve in the review room, publish through a failing wire with automatic retry),
public feed, changes-requested flag, tenant isolation, a 400 px layout, and the full OIDC round trip against the Compose Keycloak.
There is no automated browser suite yet.
