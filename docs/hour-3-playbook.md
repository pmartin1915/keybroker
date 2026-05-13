# Hour 3 — posting playbook + 7-day decision window

Operational checklist for the final hour of the validation experiment in
`POSITIONING.md`. Hour 3 is mostly user time, not model time — this doc
exists so the user can run it without re-deriving the rules.

---

## Pre-flight (10 min, before any posting)

- [ ] Decide the snippet question raised in `hour-2-posts.md`: drop the
      HN terminal snippet and lean on the Web UI screenshot only, OR
      add a `--with-scan` flag to `logs` so the real terminal output
      matches the post.
- [ ] Capture the Web UI Audit screenshot (verified=1 row on a real
      provider). Use a throwaway test account, not personal creds.
- [ ] Cross-check the post drafts against current `npm test` output
      one more time. If anything has shipped since 2026-05-12 that
      changes the headline numbers (test count, layer count), update
      the drafts.
- [ ] Confirm the GitHub repo is public, README is the un-staled
      version (commit 68020f9), and the LICENSE file is MIT.

---

## Posting schedule (3 days)

**Rule from POSITIONING.md:** one venue per day across three days.
Cross-posting in the same hour is a spam signal.

**Recommended order (rationale: warm up on the friendliest audience,
finish on the highest-stakes one):**

| Day | Venue | Best window (US Central) | Why this slot |
|---|---|---|---|
| 1 (Mon or Tue) | r/selfhosted | 8–10am or 7–9pm | Homelab audience is active mornings + evenings; weekday signal is stronger than weekend for "real operators" |
| 2 (next day) | r/devops | 9–11am | SRE-shaped audience reads at the start of their workday |
| 3 (next day) | Show HN | 6–8am | HN front page churn is highest US-morning when EU is wrapping; a post that gets <3 upvotes in 30 min is effectively dead, so timing matters most here |

**Hard rule:** if Day 1 surfaces a factual error or a critical bug
report, *fix it before Day 2*. Don't post the same flaw three times.

**Hard rule:** after each post — close the tab. POSITIONING.md says
"do not refresh." Set a calendar reminder for +24h and +7d.

---

## Reply triage rules

Reply only to **operator-shaped** comments. The test: would a real
deployer ask this?

**REPLY to:**
- Deployment questions ("does this run on k8s," "what about
  docker-compose," "how do you handle TLS")
- Integration questions ("works with vLLM / Bedrock / Anthropic," "what
  about the Responses API")
- Performance questions ("TTFT overhead," "max RPS," "memory footprint")
- Direct comparison questions ("how is this different from
  LiteLLM/Portkey/Cloudflare AI Gateway")
- Security-model questions ("where's the master key," "what if the
  broker is compromised," "HS256 why")
- Bug reports — even hostile ones. Thank, acknowledge, file an issue.

**SKIP (do not reply):**
- "Cool project" / "nice work" / generic positive feedback
- "Have you seen X" links to tangentially related tools
- Scope creep ("you should add Y feature") — file as issue if it's
  in-scope, otherwise ignore
- Vague critique without specifics ("seems over-engineered," "why not
  just use Vault")

**DO NOT REPLY to:**
- Hostile or bad-faith comments
- Off-topic threads (someone hijacking for their own project)
- Comments about pricing, business model, or "are you going to get
  acquired" — POSITIONING.md says this experiment is not testing those

**Reply shape:** ≤3 sentences. Answer the question, link to the
specific file/doc if relevant, no marketing voice.

---

## What to track during the 7-day window

Keep this section in a private note (not committed). At +24h and +7d
per post, log:

```
venue: r/selfhosted
posted: 2026-05-XX HH:MM
+24h:
  upvotes: NN
  comments_total: NN
  operator_shaped_replies: NN  # ones that match the REPLY triage list
  deploy_intent: NN  # comments containing "would use," "going to try," "deploying this"
+7d:
  upvotes: NN
  comments_total: NN
  operator_shaped_replies: NN
  deploy_intent: NN
  followup_dm_or_issue: NN  # private outreach, GitHub stars from named accounts, issues filed
```

The metric that matters is **operator_shaped_replies + deploy_intent**,
not vanity totals. 200 upvotes from people who'll never deploy this is
worse signal than 20 upvotes with 4 deploy-intent replies.

---

## Decision framework (after all 3 posts, +7d each)

Translation of the POSITIONING.md table into a mechanical rule:

**Sum across all 3 venues:**

| Total operator_shaped_replies + deploy_intent | Decision |
|---|---|
| ≥3 | Worth a slice of attention. Start the 1-week sprint: RS256, basic auth on broker, one good Docker compose example. Reach out to deploy-intent commenters by DM, offer help, try to land 1 lighthouse user. |
| 1–2 | Mixed signal. Park it. Repo stays public as portfolio + slow-burn OSS. Revisit after BoardBound has revenue. |
| 0 | Wedge isn't pulling. Stop spending time on it. The build wasn't wasted — it's a serious portfolio piece. Commit the decision doc, archive the experiment branch if you made one, return to BoardBound. |

**Hard rule from POSITIONING.md (restated):** no decision to invest
more time until the week of data is in. The temptation will be to start
building Pro-tier features pre-emptively. Resist.

---

## Failure modes to watch for

These have killed prior validation attempts in similar OSS-side-project
posts. None require action mid-experiment — just don't fall into them:

- **Drifting into reply-chains.** A 40-comment thread feels productive
  but rarely converts to deployers. Cap replies at ~6 per post.
- **Pre-emptively building.** If a comment says "this would be perfect
  if it had X," that's a signal, not a backlog item. Note it. Don't
  ship X this week.
- **Scope-shifting the pitch.** If the headline isn't pulling, the
  answer is *not* to rewrite it on the fly. The next venue gets the
  same headline; you only learn signal by holding the message steady.
- **Letting the experiment slip into Week 2.** If you haven't decided
  by Day 14, the answer is implicitly "no" — the wedge needed
  energetic interest, not slow-burn ambivalence.

---

## What happens after Hour 3

Three possible end-states, all of them resolved:

1. **Decision = invest.** New branch `phase-5-validation-followup`.
   Scope locked to: RS256, broker basic auth, Docker compose. One
   lighthouse user lands or doesn't within 30 days. Re-evaluate then.
2. **Decision = park.** Commit a one-line update to README noting the
   experiment ran and the result. Repo stays public. No further work
   scheduled. Memory entry updated.
3. **Decision = shelve.** Same as park, plus optionally archive the
   repo on GitHub. The codebase remains a portfolio artifact regardless.

Hour 3 ends when the decision is logged. Not before, not after.
