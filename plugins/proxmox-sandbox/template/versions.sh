#!/usr/bin/env bash
# Pinned versions for the agent container template. Sourced by build-template.sh and read (as plain KEY="value"
# lines) by the ePaperclip host service when it builds the template through the Proxmox API.
# Checksums are from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
# shellcheck disable=SC2034  # used by the scripts that source this file
NODE_VERSION="24.21.0"
NODE_SHA256_X64="fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
NODE_SHA256_ARM64="6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2"
# The agent CLIs (npm, installed globally in the template). Pinned, never "latest": a template built next month must
# contain what this release was tested with. Change them here and run the template build; Claude Code's licence is
# Anthropic's own, so it is installed from npm on the host that builds the template and is never redistributed by us.
CLAUDE_CODE_VERSION="2.1.310"
CODEX_VERSION="0.164.0"
GEMINI_CLI_VERSION="0.65.0"
