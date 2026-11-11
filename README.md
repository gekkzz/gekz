# Rubric reviewer (Vercel)

## Files
- `index.html` - the app (task sheet version)
- `sw.js` - streams MEGA videos into the app's player (only fetches what you watch)
- `middleware.js` + `package.json` - password gate for the whole site
- `api/check.js` - Test Against Rubric (Claude)
- `classic/index.html` - the previous app for the old single-task CSV format, at `/classic/`

## Vercel Environment Variables (Settings > Environment Variables, type Secret)
- `APP_PASSWORD` - the site password. The site stays locked until this is set.
- `ANTHROPIC_API_KEY`, `CHECK_PASSWORD` - only needed for Test Against Rubric.

After adding or changing a variable, redeploy (Deployments > newest > Redeploy).
Never put passwords or keys in these files: the GitHub repo is public.

Signing in sets a cookie for 30 days. Visit `/__logout` (the Sign out link in the header) to sign out.
