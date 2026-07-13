# Quickstart

This is a quickstart guide for the candidate-sourcing workflow.

## Prerequisites

- A Websets-enabled Exa API key. [Navigate to Websets by clicking here](https://websets.exa.ai/websets/)
- Docker Desktop installed and running on your machine. If you don't have it, [download it here](https://www.docker.com/products/docker-desktop/).
- Claude Code installed. If you don't have it, run the following command to install it:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

## Setup

1. **Write the Websets-enabled Exa API key into the `.env` file.**

2. **Change the `.mcp.json.template` file's name to `.mcp.json`.**

3. **From this project's root directory, in one terminal, run:**

```bash
pnpm install && pnpm build && docker-compose build && docker-compose up
```

In another terminal, run:

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:websets-channel
```

4. **Run the following command in Claude Code to start the workflow:**

```bash
/source-candidates-workflow (job description URL) (number of candidates to return) (optional: --more-info)
```

So, for example, if you wanted to source 25 candidates for a role at company.com/job-description, and you wanted Claude to ask you for more information about your ideal candidate, you would run the following command:

```bash
/source-candidates-workflow company.com/job-description 25 --more-info
```

5. **View the output**

The output will be a CSV file in the `exports` directory. Click on it in the file explorer, then right-click and find "Copy Path" (on Mac the shortcut is `Option + Command + C`) --> navigate to that path in your file explorer and open it in your spreadsheet program of choice.