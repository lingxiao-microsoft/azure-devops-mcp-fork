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
      enabled: z.string().optional().describe("Whether the feature should be enabled by default (true/false)"),
      branchName: z.string().optional().describe("The branch name to use (defaults to sanitized feature name)")
    },
    ({ featureName, description, enabled, branchName }) => {
      const sanitizedBranchName = branchName || featureName.toLowerCase().replace(/[^a-z0-9]/g, '-');
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: String.raw`
# Task: Create a Feature Switch

**IMPORTANT: Use the '${REPO_TOOLS.create_feature_switch}' tool directly. Do NOT manually create a branch first and then create a file separately.**

Create a new feature switch named "${featureName}" using the dedicated feature switch creation tool.

## Tool to Use:
Use **ONLY** the '${REPO_TOOLS.create_feature_switch}' tool with these parameters:
- repositoryId: "51df274b-92a1-4411-94fe-c39f70a45b86" (FeatureManagement repository)
- featureName: "${featureName}"
- description: "${description}"
- sourceBranch: "master"
- branchName: "${sanitizedBranchName}"

## What the tool will do automatically:
1. **Create a feature branch** named "${sanitizedBranchName}" from master
2. **Generate the JSON configuration file** at path: Features/Configuration/Features/${featureName}.json
3. **Use the correct PowerBI schema format** with all 12 deployment environments (onebox, test, cst, dxt, msit, prod, mc, gcc, gcchigh, dod, usnat, ussec)
4. **Commit the changes** with an appropriate message

## Expected JSON Schema (handled automatically by the tool):
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

**DO NOT use '${REPO_TOOLS.create_branch}' and '${REPO_TOOLS.create_file}' separately. The '${REPO_TOOLS.create_feature_switch}' tool handles everything in one operation.**

After creation, provide a summary of what was created including the branch name and file path.`,
            },
          },
        ],
      };
    }
  );

server.prompt(
  "update_feature_switch",
  "Updates a feature switch using rollout name, tenant IDs, or targets for a specific stage using MemberOf or NotMemberOf logic.",
  {
    featureName: z.string().describe("Name of the feature switch."),
    stage: z.string().describe("Stage to update (e.g., test, msit, prod)."),
    rolloutName: z.string().optional().describe("Rollout name like 'daily'."),
    tenantIds: z.string().optional().describe("Comma-separated tenant IDs."),
    isMember: z.string().optional().describe("false for NotMemberOf, true (or empty) for MemberOf."),
    branchName: z.string().optional().describe("Branch name (optional)."),
  },
  ({ featureName, stage, rolloutName, tenantIds, isMember, branchName }) => {
    const tenantIdArray = tenantIds ? tenantIds.split(',').map(id => id.trim()) : [];
    const defaultBranch = featureName
      ? `feature/${featureName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`
      : 'feature/unknown';
    const memberOperator = isMember === 'false' ? 'NotMemberOf' : 'MemberOf';

    const rules = [];

    if (rolloutName) {
      rules.push({
        pivot: "RolloutName",
        values: [rolloutName],
        operator: memberOperator
      });
    }

    if (tenantIdArray.length > 0) {
      rules.push({
        pivot: "TenantObjectId",
        values: tenantIdArray,
        operator: memberOperator
      });
    }

    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: JSON.stringify({
              tool: "update_feature_switch",
              args: {
                repositoryId: "51df274b-92a1-4411-94fe-c39f70a45b86",
                branchName: branchName || defaultBranch,
                featureName,
                stage,
                rules: rules.length > 0 ? rules : undefined
              }
            }, null, 2)
          }
        }
      ]
    };
  }
);

server.prompt(
    "update_feature_switch_bulk",
    "Updates multiple stages of an existing feature switch in one operation. Can enable/disable multiple stages or add tenant IDs and rollout requirements to multiple stages.",
    {
      featureName: z.string().describe("The name of the feature switch to update"),
      stages: z.string().describe("Comma-separated list of deployment stages to update (e.g., 'onebox,test,cst')"),
      action: z.enum(["enable", "disable", "tenant_rollout"]).describe("Action to perform: 'enable' (set Enabled: true), 'disable' (set Enabled: false), or 'tenant_rollout' (add tenant/rollout requirements)"),
      tenantIds: z.string().optional().describe("For tenant_rollout action: comma-separated list of tenant IDs to enable for these stages"),
      rolloutName: z.string().optional().describe("For tenant_rollout action: optional rollout name (e.g., 'daily') to add as a requirement"),
      branchName: z.string().optional().describe("The branch name (if not provided, will use feature branch naming convention)")
    },
    ({ featureName, stages, action, tenantIds, rolloutName, branchName }) => {
      const stageArray = stages ? stages.split(',').map(stage => stage.trim()) : [];
      const tenantIdArray = tenantIds ? tenantIds.split(',').map(id => id.trim()) : [];
      const defaultBranch = featureName ? `feature/${featureName.toLowerCase().replace(/[^a-z0-9]/g, '-')}` : 'feature/unknown';

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: String.raw`
# Task: Bulk Update Feature Switch for Multiple Deployment Stages

Update the feature switch "${featureName || 'unknown'}" for multiple deployment stages in one operation.

## Requirements:
1. **Use the FeatureManagement repository** (ID: 51df274b-92a1-4411-94fe-c39f70a45b86)
2. **Target branch**: ${branchName || defaultBranch}
3. **Deployment stages**: ${stageArray.join(', ')}
4. **Action**: ${action}${action === 'tenant_rollout' && tenantIdArray.length > 0 ? `\n5. **Tenant IDs**: ${tenantIdArray.join(', ')}` : ''}${action === 'tenant_rollout' && rolloutName ? `\n6. **Rollout name**: ${rolloutName}` : ''}

## Configuration Rules:
${action === 'enable' ? '- **Enable action**: Set "Enabled": true for all specified stages' : ''}${action === 'disable' ? '- **Disable action**: Set "Enabled": false for all specified stages' : ''}${action === 'tenant_rollout' ? `- **Tenant/Rollout action**: Add requirements to all specified stages${rolloutName ? `\n  - Add RolloutName requirement: "${rolloutName}"` : ''}${tenantIdArray.length > 0 ? `\n  - Add TenantObjectId requirements: ${tenantIdArray.join(', ')}` : ''}` : ''}

## Tool Usage:
Use the '${REPO_TOOLS.update_feature_switch_bulk}' tool with the following parameters:
- repositoryId: "51df274b-92a1-4411-94fe-c39f70a45b86"
- branchName: "${branchName || defaultBranch}"
- featureName: "${featureName || 'unknown'}"
- stages: [${stageArray.map(stage => `{ stage: "${stage}", ${action === 'enable' ? 'enabled: true' : action === 'disable' ? 'enabled: false' : `tenantIds: [${tenantIdArray.map(id => `"${id}"`).join(', ')}]${rolloutName ? `, rolloutName: "${rolloutName}"` : ''}`} }`).join(', ')}]

## Expected Result:
All ${stageArray.length} stage(s) will be updated with the ${action} configuration in a single commit.

After the update, provide a summary showing:
- The number of stages updated
- The configuration applied to each stage
- The commit ID
- Success confirmation for the bulk operation`,
            },
          },
        ],
      };
    }
  );
}

export { configurePrompts };
