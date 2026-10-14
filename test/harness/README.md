# UI harness

Runs the real plugin (`src/main.ts`) in a browser against `obsidian-mock.ts`, a small fake of
the Obsidian API, with the notes from `test-vault/`. For clicking through the UI without Obsidian.

    node test/harness/build.mjs
    python3 -m http.server 8770 --bind 127.0.0.1   # from the repo root
    # open http://127.0.0.1:8770/test/harness/index.html

URL flags: `?history` seeds simulated reviews, `?mobile` phone layout, `?dark`, `?reset` clears saved state.
The mock is deliberately thin — it proves the plugin's own UI and logic, not Obsidian's.
