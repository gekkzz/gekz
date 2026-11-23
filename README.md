# Rubric reviewer (Vercel)

## Files
- `index.html` - the app (task sheet version)
- `sw.js` - streams MEGA videos into the app's player (only fetches what you watch)
- `api/check.js` - Test Against Rubric (Claude)
- `api/synth.js` - Testing tab > Retest: writes a New Prompt and a Merged Prompt from the golden edit (Claude). The speech model runs in the reviewer's browser, so no extra key is needed.
- `api/clips.js` - Clips Testing tab > Scan for Pre-Edits: Claude sorts the moments the in-browser scan flagged (cuts vs false alarms) and gives each source clip a verdict.
- `classic/index.html` - the previous app for the old single-task CSV format, at `/classic/`

## Vercel Environment Variables (Settings > Environment Variables, type Secret)
- `ANTHROPIC_API_KEY`, `CHECK_PASSWORD` - needed for Test Against Rubric, Retest and Scan for Pre-Edits.

After adding or changing a variable, redeploy (Deployments > newest > Redeploy).
Never put passwords or keys in these files: the GitHub repo is public.

The site has no password: anyone with the link can open it. Sheets and videos stay in each person's browser.
