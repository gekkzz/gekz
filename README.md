# Rubric reviewer

A single-file static app: upload a rubric CSV, mark each criterion Pass or Fail,
see the weighted score, and download the edited CSV. No dependencies, no build step.

## Expected CSV columns (matched by header name, case-insensitive)

ID, Attempt 1 timestamp, Attempt 2 timestamp, Proposed final criterion,
Proposed final weight, Proposed final timestamp, and optionally Response 1 evaluation
(values Pass or Fail, loaded into the buttons if present). Other columns are not shown but are kept in the download.

## Run locally

Open `index.html` in a browser, or serve the folder:

    python3 -m http.server 3000     # then visit http://localhost:3000

## Deploy to Vercel later

    npm i -g vercel
    cd rubric-app
    vercel          # accept defaults: no framework, no build command, output directory "."

Or push the folder to GitHub and import the repo in Vercel (Framework Preset: Other).

## Score

Weighted score = total weight of Pass rows / total weight of graded rows. Ungraded rows are excluded.
Download writes the original columns only, in their original order. Pass/Fail marks are not exported.

## Editing

Click any visible cell (ID, timestamps, criterion, weight) to edit it. Edited cells get an amber bar on the left edge.
Edits are written to the downloaded CSV. Changing a weight updates the score. The browser warns before you leave with unsaved edits.

## Adding and deleting rows

"Add Row" appends an empty row (all visible columns editable; hidden columns are saved blank) and focuses it.
With no file loaded it starts a new sheet with the six visible columns. "Delete" removes a row after a confirmation.
Download reflects added and deleted rows. Rows left completely blank are skipped in the download.

## Video tabs

The header has three tabs: Rubric, Source Clips and Final Edit.

- **Upload Source Clips** accepts several videos at once and adds each as its own sub-tab, labeled by file name and sorted so Clip 2 comes before Clip 10. Uploading a file with the same name replaces it.
- **Upload Final Edit** loads one video into the Final Edit tab (uploading again replaces it).
- The player has play/pause, a seek bar, volume and mute, and a clickable timestamp in `mm:ss.mmm` format (always three millisecond digits). Click the timestamp to copy the current time. On Source Clips the copied text includes the clip name, for example `Clip 2 00:02.623` (the name comes from the file name without its extension); the Final Edit copies the time alone. The space bar also toggles play/pause.
- Each player has - and + buttons for playback speed (0.25x to 3x in 0.25 steps; click the speed label to reset to 1x), and each video keeps its own speed. Hovering the seek bar shows a small popup with the time at the mouse position. Volume and mute are shared across all players. Videos are played from your own computer and are never uploaded anywhere, so they are not saved if you reload the page.
- Playback depends on your browser's codecs. MP4 (H.264) and WebM are safest; some .mov or .mkv files may not play.

## Rubric beside the videos

On the Source Clips and Final Edit tabs the rubric appears in a panel next to the player (stacked below it on narrow screens). It is the same live table as the Rubric tab, not a copy, so edits, Pass/Fail marks, added or deleted rows and the score are always identical on every tab. Uploading a CSV or clicking Add Row works from any tab.

## The downloaded CSV

Download CSV only ever contains the CSV's own data. Videos, Pass/Fail marks and anything else in the app are never written into it. It mirrors the uploaded file's format (header names and column order, BOM, line endings, trailing newline, and whether every field is quoted), so an unedited file downloads byte-for-byte identical, and only the cells you changed differ.

## Verdict Disagreements tab

The fourth tab has a notepad on the left and the live rubric on the right. Type a criterion number, choose "Judge verdict was a pass, should have been a fail" or "Judge verdict was a fail, should have been a pass", and press Add (or Enter in the criterion field) to append a line like `12 - Judge verdict was a pass, should have been a fail. ` to the notepad (the line ends with a period and a space, and the cursor is placed right after it so you can keep typing). The notepad is a normal text area you can edit freely at any time. "Copy to clipboard" copies its text. The notepad is separate from the CSV: it is never part of the download, and it isn't saved if you reload the page (the browser warns you first if it contains text).

## Prompt tab

A notepad for pasting the task's prompt (with + and - buttons above it to change the text size, 10px to 40px), with the live rubric beside it (same shared scroll position as the other tabs). It is not part of the CSV download and is not saved on reload.

## Notes - Good and Notes - Bad tabs

Two plain notepads, each with the live rubric beside it. They are not part of the CSV download and are not saved on reload (the browser warns before you leave if any notepad has text).

## Rubric scroll position

Switching tabs keeps the rubric at the same place in the list: whichever criterion is at the top of the rubric stays at the top on the next tab, even though the layouts differ.

## Copy buttons and New Task

Both Notes tabs have a "Copy to clipboard" button at the top right of the notepad, like the Verdict Disagreements tab.

"New Task" (top middle) asks for confirmation, then clears everything: the CSV and rubric, all source clips, the final edit, and every notepad and the verdict fields. The app returns to the empty Rubric tab, ready for new uploads. Download the CSV first if you still need it.

## Keyboard and time accuracy

- **A or Left arrow** jumps back 5 seconds, **D or Right arrow** jumps forward 5 seconds, and **space** plays or pauses, on the Source Clips and Final Edit players. Holding A, D or an arrow key keeps scrubbing in that direction (a 5 second jump every 0.2 seconds after a short delay). The keys are ignored while you are typing in a text field, a dropdown, or the volume slider, and when Ctrl, Cmd or Alt is held. The speeds are the `SKIP`, `HOLD_DELAY` and `HOLD_EVERY` constants in `index.html`.
- Times are shown truncated to whole milliseconds, never rounded up (a position of 5.9996 seconds shows as `00:05.999`, not `00:06.000`). The duration, the current time, the hover popup and copied timestamps all use the same rule. Some video files store a rounded duration in the file itself, which no player can see past.

## View button (final timestamps)

In the split-view rubric (every tab except Rubric), a "View" button with a light blue outline appears in the top-right corner of a row's card, lined up with the Delete button below it, when that row's "Proposed final timestamp" is a single clip and time, such as `Clip 1 0:47.833`. Pressing it opens the Source Clips tab, selects that clip (matched to the uploaded file names ignoring case, spaces and punctuation, so `Clip 1` matches `Clip 1.mp4`), and moves the video to that time, paused. `global`, `multiple (see criterion)` and ranges such as `Clip 1 0:32.854-2:21.480` get no button. The button appears or disappears as you edit the timestamp.

Ranges such as `Clip 1 0:32.854-2:21.480` also get a View button, in a lighter blue. It jumps to the range's start time, paused.
