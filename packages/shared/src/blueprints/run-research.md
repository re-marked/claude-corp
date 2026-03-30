---
name: run-research
description: Structured research project with multiple agents collecting and synthesizing
steps: 6
roles: [CEO, Lead Researcher, Research Agents]
estimated: 1-4 hours depending on scope
---

# Run Research Blueprint

## Step 1: Define the Question
Be SPECIFIC. Not "research AI agents" but "compare Gas Town vs Claude Corp architecture for task dispatch, agent persistence, and merge queues."

## Step 2: Create Research Contract
```
cc-cli contract create --project <name> --title "Research: <topic>" --goal "<specific question to answer>" --lead @<lead-researcher> --priority normal
```

## Step 3: Lead Decomposes into Research Tasks
Each task = one research thread:
```
cc-cli task create --title "Research: <subtopic 1>" --to @<researcher-1> --priority normal
cc-cli task create --title "Research: <subtopic 2>" --to @<researcher-2> --priority normal
cc-cli task create --title "Synthesize findings into report" --to @<lead-researcher> --priority high
```
The synthesis task should have `blockedBy` pointing to the research tasks:
```
blockedBy:
  - <research-task-1-id>
  - <research-task-2-id>
```

## Step 4: Activate and Monitor
```
cc-cli contract activate --id <contract-id> --project <name>
cc-cli activity
```
Researchers work independently. The synthesis task auto-activates when research completes.

## Step 5: Lead Synthesizes
When all research tasks complete, the lead's synthesis task unblocks automatically.
The lead reads all research findings and produces a structured report in deliverables/.

## Step 6: Warden Reviews
The Warden verifies:
- All research tasks completed with actual findings (not hallucinated)
- Synthesis report exists and covers all subtopics
- Sources are cited where applicable

## Tips
- Give researchers `web_search` instructions if they need live data
- Set acceptance criteria: "Must include 3+ specific examples with source URLs"
- Research agents should write findings to their task's Progress Notes
- The lead's report goes in `projects/<name>/deliverables/`
