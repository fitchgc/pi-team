# v0.1 ships the skeleton plus the small flow only

Version 0.1 contains P0 (package skeleton, `/team init`, `/team roles`, config schema) and P1 (RPC client, `/team run` for the small flow: coder, gate, QA, shared fix budget). The big flow (architect, parallel coders, reviewer, security auditor) and P3 (status widget, resume, cost accounting) wait until the small flow has been tried on a real project.

Building the whole pipeline before anyone has run the small flow would bake in guesses about the parts that are hardest to get right (parallel fan-out, reviewer budgeting, audit triggers). A working small flow is the test bed for those decisions.
