---
name: ship-feature
description: End-to-end feature shipping — from contract to Warden approval
steps: 8
roles: [CEO, Lead, Workers, Warden, Herald]
estimated: 2-8 hours depending on feature size
---

# Ship Feature Blueprint

## Step 1: Create Project (if not exists)
```
cc-cli projects create --name "<project-name>" --type codebase
```
Skip if the project already exists.

## Step 2: Create Contract
```
cc-cli contract create --project <name> --title "<feature name>" --goal "<what it achieves>" --lead @<lead-slug> --priority high --deadline <YYYY-MM-DD>
```
The contract starts as `draft`. The lead is notified.

## Step 3: Lead Reviews & Decomposes
The lead reads the contract goal, then breaks it into tasks:
```
cc-cli task create --title "Build <component>" --to @<worker-slug> --priority high
cc-cli task create --title "Write tests for <component>" --to @<worker-slug> --priority normal
cc-cli task create --title "Integration test" --to @<lead-slug> --priority normal
```
Add task IDs to the contract:
```
cc-cli contract update --project <name> --id <contract-id> --taskIds task-abc,task-def,task-ghi
```

## Step 4: Activate Contract
```
cc-cli contract activate --id <contract-id> --project <name>
```
Work begins. The Herald narrates progress.

## Step 5: Workers Execute
Workers receive tasks via DM (Hand dispatch). They:
1. Read the task file
2. Update status to `in_progress`
3. Do the work
4. Verify acceptance criteria
5. Mark `completed`

Monitor progress:
```
cc-cli contract show --id <contract-id> --project <name>
cc-cli activity
```

## Step 6: All Tasks Complete → Warden Review
When every task in the contract is `completed`, the ContractWatcher:
1. Updates contract status to `review`
2. Auto-hands a review task to the Warden
3. Notifies the lead

No manual action needed. The system handles it.

## Step 7: Warden Verdict
The Warden reads all task files, checks acceptance criteria, verifies deliverables.

**Approved**: Contract closes. Lead and CEO notified. Herald narrates.
**Rejected**: Warden creates remediation tasks with specific feedback. Lead is notified. Fix issues and re-complete. Contract goes back to `active`.

## Step 8: Report to Founder
CEO reports the completed contract to the Founder:
```
cc-cli say --agent ceo --message "Contract '<feature>' completed and approved by Warden. Ship it."
```

## Tips
- Use `cc-cli clock` to monitor system health during execution
- If a worker is stuck > 5 minutes, Failsafe will flag it
- The Herald's narration in Corp Home gives you a live summary
- Don't skip the Warden — quality gates catch real issues
