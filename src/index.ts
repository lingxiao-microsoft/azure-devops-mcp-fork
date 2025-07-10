#!/usr/bin/env node

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as azdev from "azure-devops-node-api";
import { AccessToken, DefaultAzureCredential } from "@azure/identity";
import { configurePrompts } from "./prompts.js";
import { configureAllTools } from "./tools.js";
import { userAgent } from "./utils.js";
import { packageVersion } from "./version.js";
const args = process.argv.slice(2);
if (args.length === 0) {  console.error(
    "Usage: mcp-server-azuredevops <organization_name> [personal_access_token]"
  );
  process.exit(1);
}

export const orgName = args[0];
const patFromArgs = args[1]; // Optional PAT from command line
const orgUrl = "https://dev.azure.com/" + orgName;

async function getAzureDevOpsToken(): Promise<AccessToken> {
  // Check if a Personal Access Token is provided via command line argument
  const pat = patFromArgs || process.env.AZURE_DEVOPS_PAT;
  if (pat) {
    console.log("Using Personal Access Token for authentication");
    // Return a mock AccessToken structure with the PAT
    return {
      token: pat,
      expiresOnTimestamp: Date.now() + 3600000 // 1 hour from now
    };
  }

  console.log("Using DefaultAzureCredential for authentication");
  // Fall back to DefaultAzureCredential
  process.env.AZURE_TOKEN_CREDENTIALS = "dev";
  const credential = new DefaultAzureCredential(); // CodeQL [SM05138] resolved by explicitly setting AZURE_TOKEN_CREDENTIALS
  const token = await credential.getToken("499b84ac-1321-427f-aa17-267ca6975798/.default");
  return token;
}

async function getAzureDevOpsClient() : Promise<azdev.WebApi> {
  const token = await getAzureDevOpsToken();
  
  // Check if this is a PAT or OAuth token
  const pat = patFromArgs || process.env.AZURE_DEVOPS_PAT;
  const authHandler = pat 
    ? azdev.getPersonalAccessTokenHandler(pat)
    : azdev.getBearerHandler(token.token);
  
  const connection = new azdev.WebApi(orgUrl, authHandler, undefined, {
    productName: "AzureDevOps.MCP",
    productVersion: packageVersion,
    userAgent: userAgent
  });
  return connection;
}

async function main() {
  console.log("Starting Azure DevOps MCP Server...");
  console.log("Organization:", orgName);
  console.log("Organization URL:", orgUrl);
  console.log("PAT from args:", patFromArgs ? "PROVIDED" : "NOT PROVIDED");
  console.log("PAT from env:", process.env.AZURE_DEVOPS_PAT ? "PROVIDED" : "NOT PROVIDED");
  
  const server = new McpServer({
    name: "Azure DevOps MCP Server",
    version: packageVersion,
  });

  configurePrompts(server);
  
  configureAllTools(
    server,
    getAzureDevOpsToken,
    getAzureDevOpsClient
  );

  const transport = new StdioServerTransport();
  console.log("Azure DevOps MCP Server version : " + packageVersion);
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
