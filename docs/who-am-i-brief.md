
Who Am I
A project to track my life, achievements, failures/lessons learned, generate resumes, maintain my website, monitor my digital footprint



How can I help you today?


Choosing a framework for a mobile-ready project
Last message 2 minutes ago
Building a personal life and career tracking app
Last message 55 minutes ago
Memory
Only you
Project memory will show here after a few chats.

Instructions
Add instructions to tailor Claude’s responses

Files
1% of project capacity used

who-am-i-brief.md
68 lines

md


who-am-i-brief.md


raw
# Who Am I — Project Brief
 
## In one line
A brutally accurate, private self-database — owned and stored locally — that can be spun up as a personal ("my eyes only") webpage or dashboard, and that generates outward-facing artifacts (resume, personal site) on demand.
 
## The premise
Most people lose their own story. By the time a resume, review, or interview is due, the evidence is scattered and half-forgotten — the prompt for this whole project was a near-blank year at Bloomberg with few artifacts and faint memory. "Who Am I" exists so that never happens again: capture the truth as it happens, keep it in one place you control, and let the outputs build themselves from it.
 
Two non-negotiable principles:
 
- **Brutally accurate.** This is a record of what actually happened, not a polished narrative. Rough notes, partial memories, unflattering facts, dead ends — all of it goes in. Honesty is the whole value; a self-flattering log is useless for reconstruction and self-knowledge. Polishing happens only at the output stage (resume, site), never in the underlying record.
- **My eyes only by default.** The database is private and local-first — it lives on the owner's machine/browser, not a vendor's server. It spans both the professional record *and* the private life journey. Nothing leaves it unless explicitly exported. Public artifacts (resume, website, "how the world sees me" mentions) are generated *from* the private record but never expose it wholesale.
## What it is (and isn't)
It is a **single source of truth about one person** that:
- logs life and career events on one timeline (roles, projects, wins, skills, education, personal milestones, and external mentions);
- renders that record as a private dashboard;
- generates a tailorable **resume** (print/PDF + Markdown);
- generates a standalone **personal website** file to self-host;
- keeps a log of **how the outside world sees you** (mentions, reviews, articles, feedback).
It is **not** a hosted SaaS, a web crawler, or a website host. Those jobs are deliberately delegated to existing free services (see below).
 
## Competitive analysis — and why building this anyway is intentional
 
The market was checked before committing. Finding: **nearly every individual capability already exists, often as a better-resourced product than a solo build could be. What does not exist is the integration, on terms where the owner keeps the data.** The decision to build is therefore deliberate and narrow, not naive.
 
**Layer 1 — Career / "brag document" logging → resume. Crowded and mature.**
Tools like BragBook, Cruit, CareerLog, BragJournal, LogYourWork, and TrackToBrag all log accomplishments on a timeline and turn them into resume bullets, review content, and summaries — several with AI structuring and auto-import from GitHub/Jira/Linear/Asana.
*Implication:* the "log wins → resume" core is a solved problem. We are not trying to beat these on features; we replicate only the thin slice we need, locally.
 
**Layer 2 — Resume → personal website. Solved and hosted.**
Kickresume, Wix, GoDaddy, and LinkedIn-to-site tools (e.g. Appy Pie) convert a resume or LinkedIn profile into a hosted, SEO-ready personal site in a few clicks.
*Implication:* these *host* the site, which a local app cannot. We generate the site's files and hand off hosting to a free static host (Netlify Drop, GitHub Pages, Cloudflare Pages).
 
**Layer 3 — "How the world sees me" / reputation monitoring. Requires infrastructure we can't replicate.**
Mentionlytics, Mention, BrandYourself, and NetReputation continuously crawl the web for mentions of a person, with sentiment analysis. The free DIY equivalent most people use is Google Alerts.
*Implication:* we do not crawl the web. We let Google Alerts (or similar) do the discovery, and the owner logs notable hits into the Mentions section by hand.
 
**Why build at all, then?** Because every tool above solves *one* layer, on *its* server, for *its* slice of your life. None of them fuse the **private life-journey + the professional record + the public-perception log + the generated outputs** into **one record the owner physically holds**. That fusion, plus local-first ownership, plus the willingness to hold the unflattering truth, is the entire reason this exists. If we ever only needed one layer, the right move would be to sign up for the best existing tool instead. The integration *is* the product.
 
## Architecture stance (the deliberate split)
- **Who Am I owns:** the record (private, local), the dashboard, and the output generators (resume, site files).
- **External free services own:** live web monitoring (Google Alerts → logged as Mentions) and website hosting (static host).
This keeps the build small, genuinely owned, and free — instead of a weaker clone of six commercial products.
## Scope & phases
 
**Phase 0 — Bootstrap the app (do this first).**
Stand up and harden the "Who Am I" app itself: timeline/journal, profile, resume generator, personal-site export, and local data export/import + reset. Establish the daily/weekly capture habit. *Nothing downstream works without a working, trusted container first.*
 
**Phase 1 — Reconstruct the Bloomberg year (first real content project, after Phase 0).**
With the app working, rebuild the ~1 year at Bloomberg from surviving trails: sent email and calendar from the period, Slack/Teams history, shared-drive and repo files, the old performance review/self-assessment, and colleagues' LinkedIn for project names. Each recovered fragment becomes a journal entry; bullets get polished only at resume time. (Connected Gmail/Calendar/Drive can be searched to seed this once dates + account are provided.)
 
**Later phases (candidate).**
- Wire up Google Alerts → Mentions workflow.
- First public site published to a free host.
- Resume tailoring per application/role.
- Migrate storage if the app graduates beyond a single browser (export/import already covers this).
## Current status
A working prototype exists: a single-file local web app titled **Who Am I** with five sections — Journal, Profile, Resume, Personal site, and Data (export/import/reset) — using browser-local persistence. Resume prints to PDF or copies as Markdown; the site exports as a standalone `.html` for self-hosting. Private entries are excluded from all outward outputs automatically.
 
## Open questions
- Where should the canonical store live long-term (single browser vs. a synced file the owner controls)?
- Rough date range and the email/account the Bloomberg year lived under (needed to begin Phase 1).
- Which identity is definitively "you" online (e.g., a confirmed LinkedIn URL) to seed Mentions without pulling in the wrong "Jelani John."
 

