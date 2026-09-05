---
title: Dismiss assistant windows with Command-Escape
category: shortcut
severity: notice
introduced_in_pr: cd921ac481
date: 2026-09-05
---

## What changed

On macOS, Command-Escape closes all selection assistant result windows, including pinned windows, and stops their active requests. In the floating Quick Assistant, it stops the current response, returns to home, and hides the window.

Selection assistant footer buttons now show icons and shortcut hints. Full labels appear on hover or keyboard focus, and Close All follows the existing Stop/Close, Regenerate, and Copy actions.

## Why this matters to the user

Multiple selection windows can be dismissed together. Ordinary Escape keeps its existing stop, back, and close behavior.

## What the user should do

Use Command-Escape while an assistant has focus, or click Close All in a selection result window. Existing conversation-saving settings still apply.
