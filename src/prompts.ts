// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  McpServer
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { REPO_TOOLS } from "./tools/repos.js";

function configurePrompts(server: McpServer) {
  server.prompt(
    "relevant_pull_requests",
    "Presents the list of relevant pull requests for a given repository.",
    { repositoryId: z.string() },
    ({ repositoryId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: String.raw`
# Prerequisites
1. Unless already provided, ask user for the project name
2. Unless already provided, use '${REPO_TOOLS.list_repos_by_project}' tool to get a summarized response of the repositories in this project and ask user to select one

# Task
Find all pull requests for repository ${repositoryId} using '${REPO_TOOLS.list_pull_requests_by_repo}' tool and summarize them in a table.
Include the following columns: ID, Title, Status, Created Date, Author and Reviewers.`,
          },
        },
      ],
    })
  );

  server.prompt(
    "create_feature_switch",
    "Creates a new feature switch by creating a branch and JSON configuration file.",
    { 
      featureName: z.string().describe("The name of the feature switch"),
      description: z.string().describe("Description of what this feature controls"),
      enabled: z.string().optional().describe("Whether the feature should be enabled by default (true/false)")
    },
    ({ featureName, description, enabled }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: String.raw`
# Task: Create a Feature Switch

Create a new feature switch named "${featureName}" with the following requirements:

1. **Use the FeatureManagement repository** (ID: 51df274b-92a1-4411-94fe-c39f70a45b86)
2. **Create a feature branch** from the master branch
3. **Create a JSON configuration file** at path: Features/Configuration/Features/${featureName}.json
4. **Configuration details**:
   - Feature name: ${featureName}
   - Description: ${description}
   - Use the strict schema format with all required environments

5. **Required JSON Schema Format**:
\`\`\`json
{
  "Id": "${featureName}",
  "Description": "${description}",
  "Environments": {
    "onebox": {},
    "test": {},
    "cst": {},
    "dxt": {},
    "msit": {},
    "prod": {},
    "mc": {},
    "gcc": {},
    "gcchigh": {},
    "dod": {},
    "usnat": {},
    "ussec": {}
  }
}
\`\`\`

Use the '${REPO_TOOLS.create_feature_switch}' tool to accomplish this task.

The tool will automatically:
- Create a branch named "feature/[normalized-feature-name]"
- Generate the JSON configuration file with the exact schema format above
- Commit the changes with an appropriate message

After creation, provide a summary of what was created including the branch name and file path.`,
          },
        },
      ],
    })
  );

  server.prompt(
    "update_feature_switch",
    "Updates an existing feature switch to add tenant IDs and rollout requirements for specific deployment stages.",
    { 
      featureName: z.string().describe("The name of the feature switch to update"),
      stage: z.string().describe("The deployment stage (e.g., 'test', 'onebox', 'dxt', 'msit', 'prod')"),
      tenantIds: z.string().describe("Comma-separated list of tenant IDs to enable for this stage"),
      rolloutName: z.string().optional().describe("Optional rollout name (e.g., 'daily') to add as a requirement"),
      branchName: z.string().optional().describe("The branch name (if not provided, will use feature branch naming convention)")
    },
    ({ featureName, stage, tenantIds, rolloutName, branchName }) => {
      const tenantIdArray = tenantIds ? tenantIds.split(',').map(id => id.trim()) : [];
      const defaultBranch = featureName ? `feature/${featureName.toLowerCase().replace(/[^a-z0-9]/g, '-')}` : 'feature/unknown';
      
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: String.raw`
# Task: Update Feature Switch for Deployment Stage

Update the feature switch "${featureName || 'unknown'}" to enable it for specific tenant IDs in the "${stage || 'unknown'}" deployment stage.

## Requirements:
1. **Use the FeatureManagement repository** (ID: 51df274b-92a1-4411-94fe-c39f70a45b86)
2. **Target branch**: ${branchName || defaultBranch}
3. **Deployment stage**: ${stage || 'unknown'}
4. **Tenant IDs to enable**: ${tenantIdArray.join(', ')}${rolloutName ? `\n5. **Rollout name**: ${rolloutName}` : ''}

## Configuration Rules:
- **If rolloutName is provided**: Add RolloutName requirement with the specified value
- **Always**: Add TenantObjectId requirements for the specified tenant IDs
- **File path**: Features/Configuration/Features/${featureName || 'unknown'}.json

## Expected JSON Structure:
For the "${stage || 'unknown'}" stage, the configuration should follow the PowerBI feature switch schema:
\`\`\`json
"Environments": {
  "${stage || 'unknown'}": {
    "Requires": [
      ${rolloutName ? `{\n        "Name": "PowerBI.MemberOf",\n        "Parameters": {\n          "Pivot": "RolloutName",\n          "Values": ["${rolloutName}"]\n        }\n      },` : ''}
      {
        "Name": "PowerBI.MemberOf", 
        "Parameters": {
          "Pivot": "TenantObjectId",
          "Values": [${tenantIdArray.map(id => `"${id}"`).join(', ')}]
        }
      }
    ]
  }
}
\`\`\`

Use the '${REPO_TOOLS.update_feature_switch}' tool to accomplish this task.

After the update, provide a summary showing:
- The updated configuration for the ${stage || 'unknown'} stage
- The commit ID
- The tenant IDs that were added${rolloutName ? `\n- The rollout name: ${rolloutName}` : ''}`,
            },
          },
        ],
      };
    }
  );
}

export { configurePrompts };
