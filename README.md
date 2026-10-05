# Roblox Friend Analyzer

A static website (HTML, CSS, vanilla JavaScript) that takes a Roblox User ID and analyzes that user's public friends: account age, followers, estimated equipped-avatar value, leaderboards, search and a detail panel for each friend.

No build step, no Node, no database, no backend. It never asks for a password, `.ROBLOSECURITY` cookie or token, and never stores credentials.

Default user: **DrRobuxic**, User ID `2968372123`.

## Read this first: Roblox and CORS

The page asks Roblox's public web APIs for data straight from your visitor's browser. Roblox may refuse those requests because they come from another website (a browser rule called CORS). I could not reach Roblox from where I built this, so **I have not been able to confirm which of the endpoints below accept requests from a `github.io` page.** The app is built so you find out on first load:

1. It tries each Roblox host **directly first**.
2. If the browser blocks a host, the page says exactly which one (see the **Connection** panel) and shows what could not load. Nothing is faked and blocked data shows as **Unavailable**.
3. Only for a blocked host, and only if you configured a proxy, it retries through your own Cloudflare Worker (`worker.js`). It never uses a public CORS proxy.

If you see "Blocked by browser (CORS)", follow **Optional proxy** below. It takes about five minutes and is free.

## Files

| File | What it is |
|---|---|
| `index.html` | Page structure |
| `styles.css` | Dark dashboard styling, responsive for phones and desktop |
| `app.js` | All logic: request queue, caching, analysis, sorting, search, modal |
| `worker.js` | Optional Cloudflare Worker proxy (not needed if direct requests work) |
| `README.md` | This file |

## Put it on GitHub Pages

1. **Create the repository.** On github.com, tap **+** then **New repository**. Name it, for example, `roblox-friend-analyzer`. Choose **Public**. Create it.
2. **Upload the files.** In the new repository choose **Add file** then **Upload files**. Upload `index.html`, `styles.css`, `app.js` and `README.md`. (Upload `worker.js` too if you like. It is harmless, and not used by the page.) The files must be at the top level, not inside a folder. Tap **Commit changes**.
3. **Turn on GitHub Pages.** Go to **Settings** then **Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**. Set **Branch** to `main` and the folder to `/ (root)`. Tap **Save**.
4. **Open the site.** Wait one to two minutes, then open `https://YOUR-USERNAME.github.io/roblox-friend-analyzer/`. The Pages settings screen shows the exact link once it is live.
5. **Change the default User ID.** Two ways:
   - Per visit, with no editing: add `?id=` to the address, for example `https://YOUR-USERNAME.github.io/roblox-friend-analyzer/?id=2968372123`, or just type another ID into the box.
   - As the page default: edit `app.js` on GitHub (pencil icon) and change `DEFAULT_USER_ID: '2968372123'` near the top. Commit.

To find a User ID: open the person's Roblox profile. The number in the address (`roblox.com/users/2968372123/profile`) is the ID.

## Optional proxy (only if the Connection panel says "Blocked by browser")

1. Create a free account at <https://dash.cloudflare.com>.
2. Go to **Workers & Pages**, then **Create**, then **Hello World**, then **Deploy**. Then choose **Edit code**.
3. Delete the sample code, paste in the whole of `worker.js`, and press **Deploy**.
4. Copy the address it gives you, which looks like `https://something.your-name.workers.dev`.
5. On your site, scroll to **Connection**, open **Proxy settings**, paste the address and press **Save**. (It is kept in your own browser only. Or put it in `WORKER_URL` in `app.js` for everyone.)
6. Press **Analyze** (or **Retry failed**).

The Worker accepts only `GET`, only the five Roblox hosts listed below, and forwards no cookies or credentials. In `worker.js`, set `ALLOWED_ORIGIN` to your own `https://YOUR-USERNAME.github.io` to stop other sites using it.

## What the page shows

- **Friend list** with avatar, username, display name, User ID, creation date, account age and online status.
- **Search** by username, display name or User ID.
- **Leaderboards**: oldest account, newest account, most followers, least followers, avatar value, username A-Z, display name A-Z, plus an ascending/descending toggle. Column headers sort too. Friends with missing data always sort to the bottom.
- **Dashboard**: total, online, offline, average account age, oldest, newest, most followers, highest estimated avatar value.
- **Detail panel** (tap a friend): avatar, names, ID, created date, age, followers, following, friend count, equipped items with prices, estimated avatar value, button to the Roblox profile.

### Avatar value: what it is and is not

It is the estimated current Robux price of the items a friend **has equipped right now**. It is **not** inventory wealth and says nothing about how many Robux someone has. Rules:

- A price is shown only if Roblox returns one. Otherwise it shows **Unavailable** and the item is left out of the total. The cell shows how many items were priced, for example `6/8 priced`.
- For limited collectibles, the lowest resale price is used when Roblox provides it, and the item is labeled "Lowest resale".
- Followers, dates and counts that fail to load stay **Unavailable**. Nothing is estimated or invented.

### Online status

Roblox's presence API needs a signed-in session, which this app deliberately never uses. Online/offline therefore shows **Unavailable** unless the friend list itself includes a presence flag.

## Performance and reliability

- All requests go through one queue: `MAX_CONCURRENT_REQUESTS = 4`, a minimum gap between starts, and three priority lanes (a friend you open in the detail panel jumps the line).
- HTTP 429, 5xx and network errors are retried up to 5 times with exponential backoff and jitter. A 429 also pauses the whole queue and honors `Retry-After` when the browser can see it.
- Responses are cached in memory and in `localStorage` (user details 24 h, items 6 h, counts 15 min). Pressing Analyze again re-uses the cache, so repeats are nearly instant. **Clear cache** wipes it.
- One failed friend never stops the run. Failures are counted, summarized, and can be retried with **Retry failed**.
- The table shows 100 rows at a time ("Show more"), and images load lazily, so hundreds of friends do not freeze the page.
- Progress is shown stage by stage, for example `Loading friends: 347 / 512` and `Analyzing avatars: 120 / 512`. **Cancel** stops a run.

Expect a long friends list to take several minutes, mostly because of the per-friend requests and Roblox rate limits. Results fill in as they arrive.

## Roblox endpoints used

All are unauthenticated `GET` requests to public Roblox web APIs. `{id}` is a User ID or asset ID.

| Endpoint | What it provides | Used for |
|---|---|---|
| `users.roblox.com/v1/users/{id}` | Username, display name, creation date, description | Profile, account age |
| `friends.roblox.com/v1/users/{id}/friends` | The user's friend list (follows a `nextPageCursor` if one is returned) | Friend list |
| `friends.roblox.com/v1/users/{id}/friends/count` | Total friend count | Friends progress total, detail panel |
| `friends.roblox.com/v1/users/{id}/followers/count` | Follower count | Followers leaderboard |
| `friends.roblox.com/v1/users/{id}/followings/count` | Following count | Detail panel |
| `thumbnails.roblox.com/v1/users/avatar-headshot` | Headshot image URLs, up to 100 users per call | Avatars in the table |
| `avatar.roblox.com/v1/users/{id}/avatar` | Items the user currently has equipped | Avatar analysis |
| `economy.roblox.com/v2/assets/{id}/details` | Item name, sale price, limited status, lowest resale price if present | Avatar value |

Removed or deleted accounts that appear in a friend list (ID `-1` or marked deleted) are skipped and counted on the dashboard.

## What was and was not tested

Tested in a headless browser against a **mock** Roblox API (not the real one): 295 friends, cursor pagination, an empty list, injected HTTP 429 and 500 errors, individual 404s, a fully blocked browser (CORS), a single blocked host, the Worker fallback, sorting, search, the detail panel, cancel, repeated refreshes, and an iPhone-size layout. The mock follows the response shapes above from my knowledge of the API. If Roblox changes a response shape or blocks a host, the page will show Unavailable and say which host failed, so it is worth checking the first real run.

## Notes

- This is an unofficial tool, not affiliated with Roblox.
- It only reads information anyone can see on Roblox without signing in. Use it respectfully.
