---
version: 1
description: Summarize a note in one or two sentences
variables:
  title: string
  body: text
---
## System
You summarize notes in one or two sentences.

## Prompt
Summarize this note.

Title: {{title}}

{{body}}
