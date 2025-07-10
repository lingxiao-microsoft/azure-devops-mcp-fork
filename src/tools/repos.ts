// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AccessToken } from "@azure/identity";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebApi } from "azure-devops-node-api";
import { GitRef, GitRefUpdate, GitCommitRef, GitPush, GitChange, VersionControlChangeType, ItemContentType } from "azure-devops-node-api/interfaces/GitInterfaces.js";
import { z } from "zod";
import { getCurrentUserDetails } from "./auth.js";
import fs from 'fs';
import path from 'path';

// Constants for Git operations
// Standard Git null object ID (40 zeros) - not a secret, used for Git operations
const NULL_OBJECT_ID = "0".repeat(40);

const REPO_TOOLS = {
  list_repos_by_project: "repo_list_repos_by_project",
  list_pull_requests_by_repo: "repo_list_pull_requests_by_repo",
  list_pull_requests_by_project: "repo_list_pull_requests_by_project",
  list_branches_by_repo: "repo_list_branches_by_repo",
  list_my_branches_by_repo: "repo_list_my_branches_by_repo",
  list_pull_request_threads: "repo_list_pull_request_threads",
  list_pull_request_thread_comments: "repo_list_pull_request_thread_comments",
  get_repo_by_name_or_id: "repo_get_repo_by_name_or_id",
  get_branch_by_name: "repo_get_branch_by_name",
  get_pull_request_by_id: "repo_get_pull_request_by_id",
  create_pull_request: "repo_create_pull_request",  
  update_pull_request_status: "repo_update_pull_request_status",
  reply_to_comment: "repo_reply_to_comment",
  resolve_comment: "repo_resolve_comment",
  create_branch: "repo_create_branch",
  create_file: "repo_create_file",
  create_feature_switch: "repo_create_feature_switch",
  update_feature_switch: "repo_update_feature_switch",
};

function branchesFilterOutIrrelevantProperties(
  branches: GitRef[],
  top: number
) {
  return branches
    ?.flatMap((branch) => (branch.name ? [branch.name] : []))
    ?.filter((branch) => branch.startsWith("refs/heads/"))
    .map((branch) => branch.replace("refs/heads/", ""))
    .slice(0, top);
}

function configureRepoTools(
  server: McpServer,
  tokenProvider: () => Promise<AccessToken>,
  connectionProvider: () => Promise<WebApi>
) {
  
  server.tool(
    REPO_TOOLS.create_pull_request,
    "Create a new pull request.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request will be created."),
      sourceRefName: z.string().describe("The source branch name for the pull request, e.g., 'refs/heads/feature-branch'."),
      targetRefName: z.string().describe("The target branch name for the pull request, e.g., 'refs/heads/main'."),
      title: z.string().describe("The title of the pull request."),
      description: z.string().optional().describe("The description of the pull request. Optional."),
      isDraft: z.boolean().optional().default(false).describe("Indicates whether the pull request is a draft. Defaults to false."),
    },
    async ({
      repositoryId,
      sourceRefName,
      targetRefName,
      title,
      description,
      isDraft,
    }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const pullRequest = await gitApi.createPullRequest(
        {
          sourceRefName,
          targetRefName,
          title,
          description,
          isDraft,
        },
        repositoryId
      );

      return {
        content: [{ type: "text", text: JSON.stringify(pullRequest, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.update_pull_request_status,
    "Update status of an existing pull request to active or abandoned.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request exists."),
      pullRequestId: z.number().describe("The ID of the pull request to be published."),
      status: z.enum(["active", "abandoned"]).describe("The new status of the pull request. Can be 'active' or 'abandoned'."),
    },
    async ({ repositoryId, pullRequestId }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const statusValue = status === "active" ? 3 : 2;

      const updatedPullRequest = await gitApi.updatePullRequest(
        { status: statusValue },
        repositoryId,
        pullRequestId
      );

      return {
        content: [
          { type: "text", text: JSON.stringify(updatedPullRequest, null, 2) },
        ],
      };
    }
  ); 
 
  server.tool(
    REPO_TOOLS.list_repos_by_project,
    "Retrieve a list of repositories for a given project",
    { 
      project: z.string().describe("The name or ID of the Azure DevOps project."), 
    },
    async ({ project }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const repositories = await gitApi.getRepositories(
        project,
        false,
        false,
        false
      );

      // Filter out the irrelevant properties
      const filteredRepositories = repositories?.map((repo) => ({
        id: repo.id,
        name: repo.name,
        isDisabled: repo.isDisabled,
        isFork: repo.isFork,
        isInMaintenance: repo.isInMaintenance,
        webUrl: repo.webUrl,
        size: repo.size,
      }));

      return {
        content: [
          { type: "text", text: JSON.stringify(filteredRepositories, null, 2) },
        ],
      };
    }
  );
 
  server.tool(
    REPO_TOOLS.list_pull_requests_by_repo,
    "Retrieve a list of pull requests for a given repository.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull requests are located."),
      created_by_me: z.boolean().default(false).describe("Filter pull requests created by the current user."),
      i_am_reviewer: z.boolean().default(false).describe("Filter pull requests where the current user is a reviewer."),
    },
    async ({ repositoryId, created_by_me, i_am_reviewer }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();

      // Build the search criteria
      const searchCriteria: {
        status: number;
        repositoryId: string;
        creatorId?: string;
        reviewerId?: string;
      } = {
        status: 1,
        repositoryId: repositoryId,
      };

      if (created_by_me || i_am_reviewer) {
        const data = await getCurrentUserDetails(
          tokenProvider,
          connectionProvider
        );
        const userId = data.authenticatedUser.id;
        if (created_by_me) {
          searchCriteria.creatorId = userId;
        }
        if (i_am_reviewer) {
          searchCriteria.reviewerId = userId;
        }
      }

      const pullRequests = await gitApi.getPullRequests(
        repositoryId,
        searchCriteria
      );

      // Filter out the irrelevant properties
      const filteredPullRequests = pullRequests?.map((pr) => ({
        pullRequestId: pr.pullRequestId,
        codeReviewId: pr.codeReviewId,
        status: pr.status,
        createdBy: {
          displayName: pr.createdBy?.displayName,
          uniqueName: pr.createdBy?.uniqueName,
        },
        creationDate: pr.creationDate,
        title: pr.title,
        isDraft: pr.isDraft,
      }));

      return {
        content: [
          { type: "text", text: JSON.stringify(filteredPullRequests, null, 2) },
        ],
      };
    }
  );
 
  server.tool(
    REPO_TOOLS.list_pull_requests_by_project,
    "Retrieve a list of pull requests for a given project Id or Name.",
    {
      project: z.string().describe("The name or ID of the Azure DevOps project."),
      created_by_me: z.boolean().default(false).describe("Filter pull requests created by the current user."),
      i_am_reviewer: z.boolean().default(false).describe("Filter pull requests where the current user is a reviewer."),
    },
    async ({ project, created_by_me, i_am_reviewer }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();

      // Build the search criteria
      const gitPullRequestSearchCriteria: {
        status: number;
        creatorId?: string;
        reviewerId?: string;
      } = {
        status: 1,
      };

      if (created_by_me || i_am_reviewer) {
        const data = await getCurrentUserDetails(
          tokenProvider,
          connectionProvider
        );
        const userId = data.authenticatedUser.id;
        if (created_by_me) {
          gitPullRequestSearchCriteria.creatorId = userId;
        }
        if (i_am_reviewer) {
          gitPullRequestSearchCriteria.reviewerId = userId;
        }
      }

      const pullRequests = await gitApi.getPullRequestsByProject(
        project,
        gitPullRequestSearchCriteria
      );

      // Filter out the irrelevant properties
      const filteredPullRequests = pullRequests?.map((pr) => ({
        pullRequestId: pr.pullRequestId,
        codeReviewId: pr.codeReviewId,
        repository: pr.repository?.name,
        status: pr.status,
        createdBy: {
          displayName: pr.createdBy?.displayName,
          uniqueName: pr.createdBy?.uniqueName,
        },
        creationDate: pr.creationDate,
        title: pr.title,
        isDraft: pr.isDraft,
      }));

      return {
        content: [
          { type: "text", text: JSON.stringify(filteredPullRequests, null, 2) },
        ],
      };
    }
  );
  
  server.tool(
    REPO_TOOLS.list_pull_request_threads,
    "Retrieve a list of comment threads for a pull request.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request is located."),
      pullRequestId: z.number().describe("The ID of the pull request for which to retrieve threads."),
      project: z.string().optional().describe("Project ID or project name (optional)"),
      iteration: z.number().optional().describe("The iteration ID for which to retrieve threads. Optional, defaults to the latest iteration."),
      baseIteration: z.number().optional().describe("The base iteration ID for which to retrieve threads. Optional, defaults to the latest base iteration."),
    },
    async ({
      repositoryId,
      pullRequestId,
      project,
      iteration,
      baseIteration,
    }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();

      const threads = await gitApi.getThreads(
        repositoryId,
        pullRequestId,
        project,
        iteration,
        baseIteration
      );

      return {
        content: [{ type: "text", text: JSON.stringify(threads, null, 2) }],
      };
    }
  );
  
  server.tool(
    REPO_TOOLS.list_pull_request_thread_comments,
    "Retrieve a list of comments in a pull request thread.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request is located."),
      pullRequestId: z.number().describe("The ID of the pull request for which to retrieve thread comments."),
      threadId: z.number().describe("The ID of the thread for which to retrieve comments."),
      project: z.string().optional().describe("Project ID or project name (optional)"),
    },
    async ({ repositoryId, pullRequestId, threadId, project }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();

      // Get thread comments - GitApi uses getComments for retrieving comments from a specific thread
      const comments = await gitApi.getComments(
        repositoryId,
        pullRequestId,
        threadId,
        project
      );

      return {
        content: [{ type: "text", text: JSON.stringify(comments, null, 2) }],
      };
    }
  );
  
  server.tool(
    REPO_TOOLS.list_branches_by_repo,
    "Retrieve a list of branches for a given repository.",
    {
      repositoryId: z.string().describe("The ID of the repository where the branches are located."),
      top: z.number().default(100).describe("The maximum number of branches to return. Defaults to 100."),
    },
    async ({ repositoryId, top }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const branches = await gitApi.getRefs(repositoryId, undefined);

      const filteredBranches = branchesFilterOutIrrelevantProperties(
        branches,
        top
      );

      return {
        content: [
          { type: "text", text: JSON.stringify(filteredBranches, null, 2) },
        ],
      };
    }
  );

  server.tool(
    REPO_TOOLS.list_my_branches_by_repo,
    "Retrieve a list of my branches for a given repository Id.",
    {
      repositoryId: z.string().describe("The ID of the repository where the branches are located."),
    },
    async ({ repositoryId }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const branches = await gitApi.getRefs(
        repositoryId,
        undefined,
        undefined,
        undefined,
        undefined,
        true
      );

      return {
        content: [{ type: "text", text: JSON.stringify(branches, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.get_repo_by_name_or_id,
    "Get the repository by project and repository name or ID.",
    {
      project: z.string().describe("Project name or ID where the repository is located."),
      repositoryNameOrId: z.string().describe("Repository name or ID."),
    },
    async ({ project, repositoryNameOrId }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const repositories = await gitApi.getRepositories(project);

      const repository = repositories?.find((repo) => repo.name === repositoryNameOrId || repo.id === repositoryNameOrId);
      
      if (!repository) {
        throw new Error(
          `Repository ${repositoryNameOrId} not found in project ${project}`
        );
      }

      return {
        content: [{ type: "text", text: JSON.stringify(repository, null, 2) }],
      };
    }
  );
 
  server.tool(
    REPO_TOOLS.get_branch_by_name,
    "Get a branch by its name.",
    { 
      repositoryId: z.string().describe("The ID of the repository where the branch is located."), 
      branchName: z.string().describe("The name of the branch to retrieve, e.g., 'main' or 'feature-branch'."), 
    },
    async ({ repositoryId, branchName }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const branches = await gitApi.getRefs(repositoryId);
      const branch = branches?.find(
        (branch) => branch.name === `refs/heads/${branchName}`
      );
      if (!branch) {
        return {
          content: [
            {
              type: "text",
              text: `Branch ${branchName} not found in repository ${repositoryId}`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(branch, null, 2) }],
      };
    }
  );
 
  server.tool(
    REPO_TOOLS.get_pull_request_by_id,
    "Get a pull request by its ID.",
    { 
      repositoryId: z.string().describe("The ID of the repository where the pull request is located."), 
      pullRequestId: z.number().describe("The ID of the pull request to retrieve."), 
    },
    async ({ repositoryId, pullRequestId }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const pullRequest = await gitApi.getPullRequest(
        repositoryId,
        pullRequestId
      );
      return {
        content: [{ type: "text", text: JSON.stringify(pullRequest, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.reply_to_comment,
    "Replies to a specific comment on a pull request.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request is located."),
      pullRequestId: z.number().describe("The ID of the pull request where the comment thread exists."),
      threadId: z.number().describe("The ID of the thread to which the comment will be added."),
      content: z.string().describe("The content of the comment to be added."),
      project: z.string().optional().describe("Project ID or project name (optional)"),
    },
    async ({ repositoryId, pullRequestId, threadId, content, project }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const comment = await gitApi.createComment(
        { content },
        repositoryId,
        pullRequestId,
        threadId,
        project
      );

      return {
        content: [{ type: "text", text: JSON.stringify(comment, null, 2) }],
      };
    }
  );
  
  server.tool(
    REPO_TOOLS.resolve_comment,
    "Resolves a specific comment thread on a pull request.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request is located."),
      pullRequestId: z.number().describe("The ID of the pull request where the comment thread exists."),
      threadId: z.number().describe("The ID of the thread to be resolved."),
    },
    async ({ repositoryId, pullRequestId, threadId }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const thread = await gitApi.updateThread(
        { status: 2 }, // 2 corresponds to "Resolved" status
        repositoryId,
        pullRequestId,
        threadId
      );

      return {
        content: [{ type: "text", text: JSON.stringify(thread, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.create_branch,
    "Create a new branch from a source branch.",
    {
      repositoryId: z.string().describe("The ID of the repository where the branch will be created."),
      branchName: z.string().describe("The name of the new branch to create."),
      sourceBranch: z.string().describe("The name of the source branch to branch from (e.g., 'master', 'main')."),
    },
    async ({ repositoryId, branchName, sourceBranch }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      
      // Get the source branch reference
      const sourceRef = await gitApi.getRefs(repositoryId, undefined, `heads/${sourceBranch}`);
      if (!sourceRef || sourceRef.length === 0) {
        throw new Error(`Source branch '${sourceBranch}' not found`);
      }
      
      const sourceCommit = sourceRef[0].objectId;
      
      // Create the new branch
      const newBranchRef: GitRefUpdate = {
        name: `refs/heads/${branchName}`,
        oldObjectId: NULL_OBJECT_ID,
        newObjectId: sourceCommit
      };
      
      const result = await gitApi.updateRefs([newBranchRef], repositoryId);
      
      return {
        content: [{ 
          type: "text", 
          text: `Branch '${branchName}' created successfully from '${sourceBranch}'\n${JSON.stringify(result, null, 2)}` 
        }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.create_file,
    "Create a new file in the repository.",
    {
      repositoryId: z.string().describe("The ID of the repository where the file will be created."),
      filePath: z.string().describe("The path where the file will be created (e.g., 'Features/Configuration/Features/MyFeature.json')."),
      fileContent: z.string().describe("The content of the file to create."),
      branchName: z.string().describe("The name of the branch where the file will be created."),
      commitMessage: z.string().describe("The commit message for creating the file."),
    },
    async ({ repositoryId, filePath, fileContent, branchName, commitMessage }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      
      // Get the branch reference
      const branchRef = await gitApi.getRefs(repositoryId, undefined, `heads/${branchName}`);
      if (!branchRef || branchRef.length === 0) {
        throw new Error(`Branch '${branchName}' not found`);
      }
      
      const branchCommit = branchRef[0].objectId;
      
      // Create the file change
      const change: GitChange = {
        changeType: VersionControlChangeType.Add,
        item: {
          path: `/${filePath}`
        },
        newContent: {
          content: fileContent,
          contentType: ItemContentType.RawText
        }
      };
      
      // Create the commit
      const commit: GitCommitRef = {
        comment: commitMessage,
        changes: [change]
      };
      
      // Create the push
      const push: GitPush = {
        refUpdates: [{
          name: `refs/heads/${branchName}`,
          oldObjectId: branchCommit
          // Don't specify newObjectId - let the server calculate it from the commit
        }],
        commits: [commit]
      };
      
      const result = await gitApi.createPush(push, repositoryId);
      
      return {
        content: [{ 
          type: "text", 
          text: `File '${filePath}' created successfully on branch '${branchName}'\n${JSON.stringify(result, null, 2)}` 
        }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.create_feature_switch,
    "Create a new feature switch by creating a branch and a JSON configuration file in PowerBI format.",
    {
      repositoryId: z.string().describe("The ID of the repository (use FeatureManagement repo ID: 51df274b-92a1-4411-94fe-c39f70a45b86)."),
      featureName: z.string().describe("The name/ID of the feature switch (e.g., 'GraphQL_UseMwcTokenForSsoConnectionForSQLDB')."),
      description: z.string().describe("Description of what this feature switch controls."),
      sourceBranch: z.string().describe("The source branch to create the feature branch from.").default("master"),
      branchName: z.string().optional().describe("Custom branch name. If not provided, will use 'feature/[normalized-feature-name]' format."),
    },
    async ({ repositoryId, featureName, description, sourceBranch, branchName }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      
      // Use custom branch name if provided, otherwise use default format
      const finalBranchName = branchName || `feature/${featureName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
      
      try {
        // Step 1: Create the branch
        const sourceRef = await gitApi.getRefs(repositoryId, undefined, `heads/${sourceBranch}`);
        if (!sourceRef || sourceRef.length === 0) {
          throw new Error(`Source branch '${sourceBranch}' not found`);
        }
        
        const sourceCommit = sourceRef[0].objectId;
        
        const newBranchRef: GitRefUpdate = {
          name: `refs/heads/${finalBranchName}`,
          oldObjectId: NULL_OBJECT_ID,
          newObjectId: sourceCommit
        };
        
        await gitApi.updateRefs([newBranchRef], repositoryId);
        
        // Step 2: Create the feature configuration JSON file
        const filePath = `Features/Configuration/Features/${featureName}.json`;
        const featureConfig = {
          "Id": featureName,
          "Description": description,
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
        };
        
        const fileContent = JSON.stringify(featureConfig, null, 2);
        
        // Create the file change
        const change: GitChange = {
          changeType: VersionControlChangeType.Add,
          item: {
            path: `/${filePath}`
          },
          newContent: {
            content: fileContent,
            contentType: ItemContentType.RawText
          }
        };
        
        // Create the commit
        const commit: GitCommitRef = {
          comment: `Add feature switch configuration for ${featureName}`,
          changes: [change]
        };
        
        // Create the push
        const push: GitPush = {
          refUpdates: [{
            name: `refs/heads/${finalBranchName}`,
            oldObjectId: sourceCommit
            // Don't specify newObjectId - let the server calculate it from the commit
          }],
          commits: [commit]
        };
        
        const result = await gitApi.createPush(push, repositoryId);
        
        return {
          content: [{ 
            type: "text", 
            text: `Feature switch '${featureName}' created successfully!\n\nBranch: ${finalBranchName}\nFile: ${filePath}\n\nConfiguration:\n${fileContent}\n\nCommit: ${JSON.stringify(result.commits?.[0], null, 2)}` 
          }],
        };
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to create feature switch: ${errorMessage}`);
      }
    }
  );



  server.tool(
    REPO_TOOLS.update_feature_switch,
    "Update a feature switch JSON file to add tenant IDs and rollout requirements for specific deployment stages, or simply enable/disable a stage",
    {
      repositoryId: z.string().describe("The ID of the repository where the feature switch is located."),
      branchName: z.string().describe("The name of the branch where the feature switch exists."),
      featureName: z.string().describe("The name/ID of the feature switch to update."),
      stage: z.string().describe("The deployment stage to update (e.g., 'test', 'prod')."),
      tenantIds: z.array(z.string()).optional().describe("Optional list of tenant IDs to be added as requirements. If not provided, will be a simple enable/disable."),
      rolloutName: z.string().optional().describe("Optional rollout name (e.g., 'daily') to add as a requirement. If provided, will add RolloutName requirement."),
      enabled: z.boolean().optional().default(true).describe("Whether to enable (true) or disable (false) the feature for this stage. Only used when no tenantIds or rolloutName are provided."),
      commitMessage: z.string().optional().describe("The commit message for the update. Optional."),
    },
    async ({ repositoryId, branchName, featureName, stage, tenantIds, rolloutName, enabled, commitMessage }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      
      try {
        // Get the current branch to obtain the latest commit ID
        const branch = await gitApi.getBranch(repositoryId, branchName);
        const latestCommitId = branch.commit?.commitId;

        if (!latestCommitId) {
          throw new Error(`Could not find latest commit for branch ${branchName}`);
        }

        // Construct the file path
        const filePath = `Features/Configuration/Features/${featureName}.json`;

        // Get the current file content using getItemContent
        console.log(`Attempting to retrieve file: ${filePath} from branch: ${branchName}`);
        
        let fileContent: string | undefined;
        
        try {
          console.log(`Getting file content using getItemContent API`);
          const contentStream = await gitApi.getItemContent(
            repositoryId,
            filePath,
            undefined, // projectId
            undefined, // scopePath
            undefined, // recursionLevel
            false, // includeContentMetadata
            false, // latestProcessedChange
            false, // download
            {
              versionType: 0, // 0 = Branch, 1 = Tag, 2 = Commit
              version: branchName,
            },
            true, // includeContent
            false, // resolveLfs
            false  // sanitize
          );
          
          console.log(`Got content stream:`, !!contentStream);
          
          if (contentStream) {
            // Convert Node.js ReadableStream to string
            const chunks: any[] = [];
            
            contentStream.on('data', (chunk) => {
              chunks.push(chunk);
            });
            
            fileContent = await new Promise<string>((resolve, reject) => {
              contentStream.on('end', () => {
                const buffer = Buffer.concat(chunks);
                resolve(buffer.toString('utf-8'));
              });
              
              contentStream.on('error', (error) => {
                reject(error);
              });
            });
            
            console.log(`Successfully got file content, length: ${fileContent.length}`);
            console.log(`File content preview (first 200 chars):`, fileContent.substring(0, 200));
          } else {
            throw new Error('No content stream returned');
          }
        } catch (error: any) {
          console.log(`getItemContent failed, trying fallback method:`, error?.message || error);
          
          // Fallback: Try using direct REST API call
          try {
            const token = await tokenProvider();
            const itemsUrl = `https://dev.azure.com/powerbi/_apis/git/repositories/${repositoryId}/items?path=${encodeURIComponent(filePath)}&versionType=Branch&version=${encodeURIComponent(branchName)}&includeContent=true&api-version=7.2-preview.1`;
            
            const response = await fetch(itemsUrl, {
              headers: {
                'Authorization': `Bearer ${token.token}`,
                'User-Agent': 'AzureDevOpsMCP/1.0',
                'Accept': 'application/json'
              }
            });
            
            console.log(`REST API response status: ${response.status} ${response.statusText}`);
            
            if (response.ok) {
              const data = await response.json();
              fileContent = data.content;
              console.log(`Fallback method result - Has content:`, !!fileContent, `Content length:`, fileContent?.length || 0);
            } else {
              const errorText = await response.text();
              console.log(`REST API failed - HTTP ${response.status}: ${response.statusText}. Error: ${errorText}`);
              throw new Error(`Could not retrieve file via REST API: ${response.status} ${response.statusText}`);
            }
          } catch (fallbackError: any) {
            console.log(`Fallback method also failed:`, fallbackError?.message || fallbackError);
            throw new Error(`Could not find file: ${filePath} on branch: ${branchName}. Error: ${error?.message || error}`);
          }
        }

        if (!fileContent) {
          throw new Error(`Could not find feature switch file content: ${filePath}`);
        }

        // Parse the current JSON
        const currentConfig = JSON.parse(fileContent);
        
        console.log(`Current config structure:`, JSON.stringify(currentConfig, null, 2));

        // Ensure the Environments object exists
        if (!currentConfig.Environments) {
          throw new Error(`'Environments' section not found in feature switch configuration`);
        }

        // Ensure the stage exists under Environments
        if (!currentConfig.Environments.hasOwnProperty(stage)) {
          throw new Error(`Stage '${stage}' not found in Environments section. Available stages: ${Object.keys(currentConfig.Environments).join(', ')}`);
        }

        // Check if this is a simple enable/disable request (no rollout or tenant requirements)
        const hasRequirements = rolloutName || (tenantIds && tenantIds.length > 0);
        
        if (!hasRequirements) {
          // Simple enable/disable request - set Enabled: true/false
          currentConfig.Environments[stage] = {
            Enabled: enabled
          };
        } else {
          // Complex requirements - use Requires array
          const requires = [];

          // Add RolloutName requirement if provided by user
          if (rolloutName) {
            requires.push({
              "Name": "PowerBI.MemberOf",
              "Parameters": {
                "Pivot": "RolloutName",
                "Values": [rolloutName]
              }
            });
          }

          // Add tenant ID requirements
          if (tenantIds && tenantIds.length > 0) {
            requires.push({
              "Name": "PowerBI.MemberOf",
              "Parameters": {
                "Pivot": "TenantObjectId",
                "Values": tenantIds
              }
            });
          }

          // Update the stage configuration under Environments with requirements
          currentConfig.Environments[stage] = {
            Requires: requires
          };
        }

        // Convert back to JSON string with proper formatting
        const updatedContent = JSON.stringify(currentConfig, null, 2);

        // Create the push with the updated file
        const push = {
          refUpdates: [
            {
              name: `refs/heads/${branchName}`,
              oldObjectId: latestCommitId,
            },
          ],
          commits: [
            {
              comment: commitMessage || `Update feature switch ${featureName} for ${stage} stage with tenant IDs`,
              changes: [
                {
                  changeType: VersionControlChangeType.Edit,
                  item: {
                    path: `/${filePath}`,
                  },
                  newContent: {
                    content: updatedContent,
                    contentType: ItemContentType.RawText,
                  },
                },
              ],
            },
          ],
        };

        const result = await gitApi.createPush(push, repositoryId);

        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            message: `Successfully updated feature switch ${featureName} for ${stage} stage`,
            branchName,
            filePath,
            commitId: result.commits?.[0]?.commitId,
            tenantIds,
            stage,
            updatedConfig: currentConfig.Environments[stage]
          }, null, 2) }],
        };

      } catch (error: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: false,
            error: error.message,
            repositoryId,
            branchName,
            featureName,
            stage,
            tenantIds,
          }, null, 2) }],
        };
      }
    }
  );
}

// Helper function to log to both console and file
function debugLog(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}${data ? ': ' + JSON.stringify(data) : ''}`;
  
  console.log(logMessage);
  
  // Also write to a log file
  try {
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, 'mcp-debug.log');
    fs.appendFileSync(logFile, logMessage + '\n');
  } catch (error) {
    console.error('Failed to write to log file:', error);
  }
}

export { REPO_TOOLS, configureRepoTools };
