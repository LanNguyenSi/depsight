import { Octokit } from '@octokit/rest';

export function createGitHubClient(accessToken: string) {
  return new Octokit({
    auth: accessToken,
  });
}

export async function getUserRepos(accessToken: string) {
  const octokit = createGitHubClient(accessToken);

  const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
    visibility: 'all',
    affiliation: 'owner,collaborator,organization_member',
    sort: 'updated',
    per_page: 100,
  });

  return repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    private: repo.private,
    url: repo.html_url,
    defaultBranch: repo.default_branch,
    updatedAt: repo.updated_at,
    language: repo.language,
    owner: {
      login: repo.owner.login,
      avatarUrl: repo.owner.avatar_url,
    },
  }));
}

export async function getRepoDependencyFiles(
  accessToken: string,
  owner: string,
  repo: string,
) {
  const octokit = createGitHubClient(accessToken);

  const dependencyFiles = [
    'package.json',
    'requirements.txt',
    'Pipfile',
    'pyproject.toml',
    'go.mod',
    'Cargo.toml',
    'pom.xml',
    'build.gradle',
    'composer.json',
    'Gemfile',
  ];

  const found: { path: string; content: string }[] = [];

  for (const file of dependencyFiles) {
    try {
      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: file,
      });

      if ('content' in response.data) {
        const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
        found.push({ path: file, content });
      }
    } catch {
      // File not found in this repo, skip
    }
  }

  return found;
}
