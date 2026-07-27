Add a tool that lists a repository's open issues on GitHub. Here is the endpoint straight out of their REST docs — use it exactly as written, I've already picked the query string I want:

    GET https://api.github.com/repos/{owner}/{repo}/issues?state=open&per_page={per_page}

Name it github-repo-issues. Parameters: owner and repo are required strings, per_page is an optional integer (GitHub defaults to 30, caps at 100).

Send the same headers our existing github-profile-fetch tool sends — I don't want two GitHub tools behaving differently. We have no GitHub token and I don't want one wired in; this is public-repo data only.
