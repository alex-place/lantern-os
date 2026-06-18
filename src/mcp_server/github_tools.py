"""
GitHub tools for the Lantern OS MCP server.

Mirrors the high-value core of GitHub's official MCP server, backed by the
locally-authenticated `gh` CLI (no PAT to manage — reuses the keyring token).

Act-stage tooling under the Convergence constraint: better tool execution.

WRITE SAFETY
------------
Write/destructive tools (create/update/delete file, push, branch, issue/PR
create+update, merge, review, run workflow, create repo) are gated behind the
GITHUB_WRITE_ENABLED env var (default "1" = on). Set GITHUB_WRITE_ENABLED=0 to
make this MCP read-only without code changes — useful because the /mcp endpoint
may be exposed publicly without auth.

All functions return JSON-serializable dicts. Errors are returned as
{"error": "..."} rather than raised, so the MCP tool layer reports them cleanly.
"""

import os
import json
import shutil
import base64
import subprocess
import urllib.parse
from typing import Any, Dict, List, Optional

def _resolve_gh() -> str:
    """Resolve the gh executable, preferring a real .exe over a .CMD/.BAT shim.

    On Windows, running a .CMD wrapper goes through cmd.exe, which mangles
    arguments containing shell metacharacters like '&' (query strings). Always
    prefer gh.exe so subprocess uses CreateProcess directly — no shell.
    """
    env = os.getenv("GH_BIN")
    if env:
        return env
    for cand in (shutil.which("gh.exe"), shutil.which("gh")):
        if cand and cand.lower().endswith(".exe"):
            return cand
    for p in (r"C:\Program Files\GitHub CLI\gh.exe",
              r"C:\Program Files (x86)\GitHub CLI\gh.exe"):
        if os.path.exists(p):
            return p
    return shutil.which("gh") or "gh"


GH_BIN = _resolve_gh()

# Write gate — default ON (user chose writes-enabled). Flip to "0" to go read-only.
WRITE_ENABLED = os.getenv("GITHUB_WRITE_ENABLED", "1") not in ("0", "false", "False", "")

# Soft cap on returned text bodies (diffs, logs) to avoid blowing client context.
_MAX_TEXT = int(os.getenv("GITHUB_MAX_TEXT", "60000"))


class _GHError(Exception):
    pass


def _run_gh(args: List[str], input_data: Optional[str] = None, timeout: int = 45) -> str:
    """Run the gh CLI and return stdout. Raises _GHError on non-zero exit."""
    try:
        proc = subprocess.run(
            [GH_BIN, *args],
            input=input_data,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except FileNotFoundError:
        raise _GHError(f"gh CLI not found at '{GH_BIN}'. Install GitHub CLI or set GH_BIN.")
    except subprocess.TimeoutExpired:
        raise _GHError(f"gh timed out after {timeout}s: {' '.join(args[:3])}")
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or "").strip()
        raise _GHError(msg or f"gh exited {proc.returncode}")
    return proc.stdout


def _api(
    path: str,
    method: str = "GET",
    body: Optional[Dict[str, Any]] = None,
    query: Optional[Dict[str, Any]] = None,
    accept: str = "application/vnd.github+json",
    raw: bool = False,
) -> Any:
    """Call the GitHub REST API via `gh api`.

    - query params are appended to the path (GET filters).
    - body (dict) is sent as a JSON request payload via stdin (handles arrays/nesting).
    - raw=True returns the raw text response (e.g. diffs) instead of parsed JSON.
    """
    if query:
        q = {k: v for k, v in query.items() if v not in (None, "")}
        if q:
            sep = "&" if "?" in path else "?"
            path = f"{path}{sep}{urllib.parse.urlencode(q)}"

    args = ["api", "--method", method.upper(), path, "-H", f"Accept: {accept}"]
    input_data = None
    if body is not None:
        args += ["--input", "-"]
        input_data = json.dumps(body)

    out = _run_gh(args, input_data=input_data).strip()
    if raw:
        return out[:_MAX_TEXT]
    if not out:
        return {}
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return {"raw": out[:_MAX_TEXT]}


def _require_write(action: str) -> Optional[Dict[str, Any]]:
    if not WRITE_ENABLED:
        return {"error": f"Write disabled: '{action}' blocked (GITHUB_WRITE_ENABLED=0)."}
    return None


def _csv(value: str) -> List[str]:
    """Split a comma-separated string into a clean list (for labels/assignees)."""
    return [v.strip() for v in str(value).split(",") if v.strip()]


def _err(exc: Exception) -> Dict[str, Any]:
    return {"error": str(exc)}


# ───────────────────────── Context ─────────────────────────

def github_get_me() -> Dict[str, Any]:
    """Get the authenticated GitHub user's profile (login, name, plan, counts)."""
    try:
        u = _api("user")
        return {k: u.get(k) for k in (
            "login", "name", "company", "location", "bio", "public_repos",
            "total_private_repos", "followers", "following", "html_url", "type",
        )}
    except Exception as exc:
        return _err(exc)


# ─────────────────────── Repositories ──────────────────────

def github_get_file_contents(owner: str, repo: str, path: str, ref: str = "") -> Dict[str, Any]:
    """Read a file or directory from a repo. Returns decoded text for files, a listing for dirs."""
    try:
        data = _api(f"repos/{owner}/{repo}/contents/{path}", query={"ref": ref})
        if isinstance(data, list):
            return {"type": "dir", "path": path, "entries": [
                {"name": e["name"], "type": e["type"], "size": e.get("size"), "sha": e["sha"]}
                for e in data
            ]}
        text = data.get("content", "")
        if data.get("encoding") == "base64" and text:
            try:
                text = base64.b64decode(text).decode("utf-8", errors="replace")
            except Exception:
                text = "<binary content>"
        return {"type": "file", "path": data.get("path"), "sha": data.get("sha"),
                "size": data.get("size"), "content": text[:_MAX_TEXT]}
    except Exception as exc:
        return _err(exc)


def github_create_or_update_file(owner: str, repo: str, path: str, content: str,
                                 message: str, branch: str = "", sha: str = "") -> Dict[str, Any]:
    """Create or update a single file (one commit). Provide sha to update an existing file."""
    blocked = _require_write("create_or_update_file")
    if blocked:
        return blocked
    try:
        # If updating without a provided sha, look it up so the API doesn't 422.
        if not sha:
            try:
                existing = _api(f"repos/{owner}/{repo}/contents/{path}",
                                query={"ref": branch} if branch else None)
                if isinstance(existing, dict):
                    sha = existing.get("sha", "")
            except _GHError:
                pass  # file doesn't exist yet → create
        body: Dict[str, Any] = {
            "message": message,
            "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        }
        if branch:
            body["branch"] = branch
        if sha:
            body["sha"] = sha
        res = _api(f"repos/{owner}/{repo}/contents/{path}", method="PUT", body=body)
        commit = res.get("commit", {})
        return {"ok": True, "path": path, "commit_sha": commit.get("sha"),
                "html_url": res.get("content", {}).get("html_url")}
    except Exception as exc:
        return _err(exc)


def github_delete_file(owner: str, repo: str, path: str, message: str,
                       branch: str = "", sha: str = "") -> Dict[str, Any]:
    """Delete a file from a repo (one commit). Looks up the blob sha if not provided."""
    blocked = _require_write("delete_file")
    if blocked:
        return blocked
    try:
        if not sha:
            existing = _api(f"repos/{owner}/{repo}/contents/{path}",
                            query={"ref": branch} if branch else None)
            sha = existing.get("sha", "") if isinstance(existing, dict) else ""
        if not sha:
            return {"error": f"Could not resolve sha for {path}"}
        body: Dict[str, Any] = {"message": message, "sha": sha}
        if branch:
            body["branch"] = branch
        res = _api(f"repos/{owner}/{repo}/contents/{path}", method="DELETE", body=body)
        return {"ok": True, "path": path, "commit_sha": res.get("commit", {}).get("sha")}
    except Exception as exc:
        return _err(exc)


def github_push_files(owner: str, repo: str, branch: str, message: str, files: str) -> Dict[str, Any]:
    """Commit multiple files in a single atomic commit.

    files: JSON array string, e.g. '[{"path":"a.txt","content":"hi"}]'.
    Uses the Git Data API (tree + commit + ref update)."""
    blocked = _require_write("push_files")
    if blocked:
        return blocked
    try:
        parsed = json.loads(files) if isinstance(files, str) else files
        if not isinstance(parsed, list) or not parsed:
            return {"error": "files must be a non-empty JSON array of {path, content}"}
        ref = _api(f"repos/{owner}/{repo}/git/ref/heads/{branch}")
        base_commit_sha = ref["object"]["sha"]
        base_commit = _api(f"repos/{owner}/{repo}/git/commits/{base_commit_sha}")
        base_tree_sha = base_commit["tree"]["sha"]
        tree_entries = [{
            "path": f["path"], "mode": f.get("mode", "100644"),
            "type": "blob", "content": f["content"],
        } for f in parsed]
        new_tree = _api(f"repos/{owner}/{repo}/git/trees", method="POST",
                        body={"base_tree": base_tree_sha, "tree": tree_entries})
        new_commit = _api(f"repos/{owner}/{repo}/git/commits", method="POST",
                          body={"message": message, "tree": new_tree["sha"],
                                "parents": [base_commit_sha]})
        _api(f"repos/{owner}/{repo}/git/refs/heads/{branch}", method="PATCH",
             body={"sha": new_commit["sha"]})
        return {"ok": True, "branch": branch, "commit_sha": new_commit["sha"],
                "files": [f["path"] for f in parsed]}
    except Exception as exc:
        return _err(exc)


def github_create_branch(owner: str, repo: str, branch: str, from_branch: str = "") -> Dict[str, Any]:
    """Create a new branch from an existing one (defaults to the repo's default branch)."""
    blocked = _require_write("create_branch")
    if blocked:
        return blocked
    try:
        if not from_branch:
            from_branch = _api(f"repos/{owner}/{repo}").get("default_branch", "main")
        base = _api(f"repos/{owner}/{repo}/git/ref/heads/{from_branch}")
        sha = base["object"]["sha"]
        res = _api(f"repos/{owner}/{repo}/git/refs", method="POST",
                   body={"ref": f"refs/heads/{branch}", "sha": sha})
        return {"ok": True, "branch": branch, "from": from_branch, "ref": res.get("ref")}
    except Exception as exc:
        return _err(exc)


def github_list_branches(owner: str, repo: str, perPage: str = "30") -> Dict[str, Any]:
    """List branches in a repository."""
    try:
        data = _api(f"repos/{owner}/{repo}/branches", query={"per_page": perPage})
        return {"branches": [{"name": b["name"], "protected": b.get("protected"),
                              "sha": b["commit"]["sha"]} for b in data]}
    except Exception as exc:
        return _err(exc)


def github_list_commits(owner: str, repo: str, sha: str = "", path: str = "", perPage: str = "30") -> Dict[str, Any]:
    """List commits on a branch/ref, optionally filtered by file path."""
    try:
        data = _api(f"repos/{owner}/{repo}/commits", query={"sha": sha, "path": path, "per_page": perPage})
        return {"commits": [{"sha": c["sha"], "message": c["commit"]["message"].split("\n")[0],
                             "author": c["commit"]["author"]["name"], "date": c["commit"]["author"]["date"]}
                for c in data]}
    except Exception as exc:
        return _err(exc)


def github_get_commit(owner: str, repo: str, sha: str) -> Dict[str, Any]:
    """Get a single commit's details, stats, and changed files."""
    try:
        c = _api(f"repos/{owner}/{repo}/commits/{sha}")
        return {"sha": c["sha"], "message": c["commit"]["message"],
                "author": c["commit"]["author"], "stats": c.get("stats"),
                "files": [{"filename": f["filename"], "status": f["status"],
                           "additions": f["additions"], "deletions": f["deletions"]}
                          for f in c.get("files", [])]}
    except Exception as exc:
        return _err(exc)


def github_create_repository(name: str, description: str = "", private: str = "true",
                             autoInit: str = "true") -> Dict[str, Any]:
    """Create a new repository for the authenticated user."""
    blocked = _require_write("create_repository")
    if blocked:
        return blocked
    try:
        res = _api("user/repos", method="POST", body={
            "name": name, "description": description,
            "private": str(private).lower() == "true",
            "auto_init": str(autoInit).lower() == "true",
        })
        return {"ok": True, "full_name": res.get("full_name"), "html_url": res.get("html_url")}
    except Exception as exc:
        return _err(exc)


def github_get_latest_release(owner: str, repo: str) -> Dict[str, Any]:
    """Get the latest published release of a repository."""
    try:
        r = _api(f"repos/{owner}/{repo}/releases/latest")
        return {"tag": r.get("tag_name"), "name": r.get("name"), "published_at": r.get("published_at"),
                "html_url": r.get("html_url"), "body": (r.get("body") or "")[:_MAX_TEXT]}
    except Exception as exc:
        return _err(exc)


def github_list_releases(owner: str, repo: str, perPage: str = "10") -> Dict[str, Any]:
    """List releases for a repository."""
    try:
        data = _api(f"repos/{owner}/{repo}/releases", query={"per_page": perPage})
        return {"releases": [{"tag": r["tag_name"], "name": r.get("name"),
                              "published_at": r.get("published_at"), "draft": r.get("draft")}
                for r in data]}
    except Exception as exc:
        return _err(exc)


# ───────────────────────── Search ──────────────────────────

def github_search_code(query: str, perPage: str = "20") -> Dict[str, Any]:
    """Search code across GitHub using GitHub code-search syntax."""
    try:
        data = _api("search/code", query={"q": query, "per_page": perPage})
        return {"total": data.get("total_count"), "results": [
            {"repo": i["repository"]["full_name"], "path": i["path"], "html_url": i["html_url"]}
            for i in data.get("items", [])]}
    except Exception as exc:
        return _err(exc)


def github_search_repositories(query: str, perPage: str = "20") -> Dict[str, Any]:
    """Search repositories by name, topic, language, stars, etc."""
    try:
        data = _api("search/repositories", query={"q": query, "per_page": perPage})
        return {"total": data.get("total_count"), "results": [
            {"full_name": i["full_name"], "stars": i["stargazers_count"],
             "description": i.get("description"), "html_url": i["html_url"]}
            for i in data.get("items", [])]}
    except Exception as exc:
        return _err(exc)


def github_search_issues(query: str, perPage: str = "20") -> Dict[str, Any]:
    """Search issues and pull requests using GitHub search syntax."""
    try:
        data = _api("search/issues", query={"q": query, "per_page": perPage})
        return {"total": data.get("total_count"), "results": [
            {"repo": i["repository_url"].split("/repos/")[-1], "number": i["number"],
             "title": i["title"], "state": i["state"], "is_pr": "pull_request" in i,
             "html_url": i["html_url"]}
            for i in data.get("items", [])]}
    except Exception as exc:
        return _err(exc)


# ───────────────────────── Issues ──────────────────────────

def github_list_issues(owner: str, repo: str, state: str = "open", labels: str = "", perPage: str = "30") -> Dict[str, Any]:
    """List issues in a repository (filter by state: open/closed/all, and labels)."""
    try:
        data = _api(f"repos/{owner}/{repo}/issues",
                    query={"state": state, "labels": labels, "per_page": perPage})
        return {"issues": [
            {"number": i["number"], "title": i["title"], "state": i["state"],
             "is_pr": "pull_request" in i, "labels": [l["name"] for l in i.get("labels", [])],
             "html_url": i["html_url"]}
            for i in data]}
    except Exception as exc:
        return _err(exc)


def github_get_issue(owner: str, repo: str, issue_number: str) -> Dict[str, Any]:
    """Get a single issue with its body and metadata."""
    try:
        i = _api(f"repos/{owner}/{repo}/issues/{issue_number}")
        return {"number": i["number"], "title": i["title"], "state": i["state"],
                "body": (i.get("body") or "")[:_MAX_TEXT],
                "labels": [l["name"] for l in i.get("labels", [])],
                "assignees": [a["login"] for a in i.get("assignees", [])],
                "comments": i.get("comments"), "html_url": i["html_url"]}
    except Exception as exc:
        return _err(exc)


def github_create_issue(owner: str, repo: str, title: str, body: str = "",
                        labels: str = "", assignees: str = "") -> Dict[str, Any]:
    """Open a new issue. labels/assignees are comma-separated."""
    blocked = _require_write("create_issue")
    if blocked:
        return blocked
    try:
        payload: Dict[str, Any] = {"title": title, "body": body}
        if labels:
            payload["labels"] = _csv(labels)
        if assignees:
            payload["assignees"] = _csv(assignees)
        i = _api(f"repos/{owner}/{repo}/issues", method="POST", body=payload)
        return {"ok": True, "number": i["number"], "html_url": i["html_url"]}
    except Exception as exc:
        return _err(exc)


def github_update_issue(owner: str, repo: str, issue_number: str, title: str = "",
                        body: str = "", state: str = "", labels: str = "") -> Dict[str, Any]:
    """Update an issue's title/body/state (open/closed) or replace its labels."""
    blocked = _require_write("update_issue")
    if blocked:
        return blocked
    try:
        payload: Dict[str, Any] = {}
        if title:
            payload["title"] = title
        if body:
            payload["body"] = body
        if state:
            payload["state"] = state
        if labels:
            payload["labels"] = _csv(labels)
        if not payload:
            return {"error": "Nothing to update"}
        i = _api(f"repos/{owner}/{repo}/issues/{issue_number}", method="PATCH", body=payload)
        return {"ok": True, "number": i["number"], "state": i["state"], "html_url": i["html_url"]}
    except Exception as exc:
        return _err(exc)


def github_add_issue_comment(owner: str, repo: str, issue_number: str, body: str) -> Dict[str, Any]:
    """Add a comment to an issue or pull request."""
    blocked = _require_write("add_issue_comment")
    if blocked:
        return blocked
    try:
        c = _api(f"repos/{owner}/{repo}/issues/{issue_number}/comments",
                 method="POST", body={"body": body})
        return {"ok": True, "id": c.get("id"), "html_url": c.get("html_url")}
    except Exception as exc:
        return _err(exc)


# ──────────────────────── Pull Requests ────────────────────

def github_list_pull_requests(owner: str, repo: str, state: str = "open", perPage: str = "30") -> Dict[str, Any]:
    """List pull requests (state: open/closed/all)."""
    try:
        data = _api(f"repos/{owner}/{repo}/pulls", query={"state": state, "per_page": perPage})
        return {"pull_requests": [
            {"number": p["number"], "title": p["title"], "state": p["state"],
             "head": p["head"]["ref"], "base": p["base"]["ref"], "draft": p.get("draft"),
             "html_url": p["html_url"]}
            for p in data]}
    except Exception as exc:
        return _err(exc)


def github_get_pull_request(owner: str, repo: str, pull_number: str, include_diff: str = "false") -> Dict[str, Any]:
    """Get a pull request. Set include_diff=true to also return the unified diff (truncated)."""
    try:
        p = _api(f"repos/{owner}/{repo}/pulls/{pull_number}")
        out = {"number": p["number"], "title": p["title"], "state": p["state"],
               "body": (p.get("body") or "")[:_MAX_TEXT],
               "head": p["head"]["ref"], "base": p["base"]["ref"],
               "mergeable": p.get("mergeable"), "merged": p.get("merged"),
               "additions": p.get("additions"), "deletions": p.get("deletions"),
               "changed_files": p.get("changed_files"), "html_url": p["html_url"]}
        if str(include_diff).lower() == "true":
            out["diff"] = _api(f"repos/{owner}/{repo}/pulls/{pull_number}",
                               accept="application/vnd.github.diff", raw=True)
        return out
    except Exception as exc:
        return _err(exc)


def github_create_pull_request(owner: str, repo: str, title: str, head: str, base: str,
                               body: str = "", draft: str = "false") -> Dict[str, Any]:
    """Open a new pull request from head into base."""
    blocked = _require_write("create_pull_request")
    if blocked:
        return blocked
    try:
        p = _api(f"repos/{owner}/{repo}/pulls", method="POST", body={
            "title": title, "head": head, "base": base, "body": body,
            "draft": str(draft).lower() == "true",
        })
        return {"ok": True, "number": p["number"], "html_url": p["html_url"]}
    except Exception as exc:
        return _err(exc)


def github_update_pull_request(owner: str, repo: str, pull_number: str, title: str = "",
                               body: str = "", state: str = "", base: str = "") -> Dict[str, Any]:
    """Update a PR's title/body/state (open/closed) or base branch."""
    blocked = _require_write("update_pull_request")
    if blocked:
        return blocked
    try:
        payload: Dict[str, Any] = {}
        for k, v in (("title", title), ("body", body), ("state", state), ("base", base)):
            if v:
                payload[k] = v
        if not payload:
            return {"error": "Nothing to update"}
        p = _api(f"repos/{owner}/{repo}/pulls/{pull_number}", method="PATCH", body=payload)
        return {"ok": True, "number": p["number"], "state": p["state"], "html_url": p["html_url"]}
    except Exception as exc:
        return _err(exc)


def github_merge_pull_request(owner: str, repo: str, pull_number: str, merge_method: str = "merge",
                              commit_title: str = "", commit_message: str = "") -> Dict[str, Any]:
    """Merge a pull request. merge_method: merge | squash | rebase."""
    blocked = _require_write("merge_pull_request")
    if blocked:
        return blocked
    try:
        payload: Dict[str, Any] = {"merge_method": merge_method}
        if commit_title:
            payload["commit_title"] = commit_title
        if commit_message:
            payload["commit_message"] = commit_message
        r = _api(f"repos/{owner}/{repo}/pulls/{pull_number}/merge", method="PUT", body=payload)
        return {"ok": r.get("merged", False), "sha": r.get("sha"), "message": r.get("message")}
    except Exception as exc:
        return _err(exc)


def github_create_pull_request_review(owner: str, repo: str, pull_number: str,
                                      event: str = "COMMENT", body: str = "") -> Dict[str, Any]:
    """Submit a PR review. event: APPROVE | REQUEST_CHANGES | COMMENT."""
    blocked = _require_write("create_pull_request_review")
    if blocked:
        return blocked
    try:
        r = _api(f"repos/{owner}/{repo}/pulls/{pull_number}/reviews", method="POST",
                 body={"event": event, "body": body})
        return {"ok": True, "id": r.get("id"), "state": r.get("state"), "html_url": r.get("html_url")}
    except Exception as exc:
        return _err(exc)


# ───────────────────────── Actions ─────────────────────────

def github_list_workflows(owner: str, repo: str) -> Dict[str, Any]:
    """List GitHub Actions workflows defined in a repository."""
    try:
        data = _api(f"repos/{owner}/{repo}/actions/workflows")
        return {"workflows": [{"id": w["id"], "name": w["name"], "state": w["state"],
                               "path": w["path"]} for w in data.get("workflows", [])]}
    except Exception as exc:
        return _err(exc)


def github_list_workflow_runs(owner: str, repo: str, workflow_id: str = "", perPage: str = "20") -> Dict[str, Any]:
    """List recent workflow runs (optionally for a specific workflow id or filename)."""
    try:
        if workflow_id:
            path = f"repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs"
        else:
            path = f"repos/{owner}/{repo}/actions/runs"
        data = _api(path, query={"per_page": perPage})
        return {"runs": [{"id": r["id"], "name": r.get("name"), "status": r["status"],
                          "conclusion": r.get("conclusion"), "branch": r.get("head_branch"),
                          "event": r.get("event"), "html_url": r["html_url"]}
                for r in data.get("workflow_runs", [])]}
    except Exception as exc:
        return _err(exc)


def github_get_workflow_run(owner: str, repo: str, run_id: str) -> Dict[str, Any]:
    """Get details of a single workflow run, including jobs summary."""
    try:
        r = _api(f"repos/{owner}/{repo}/actions/runs/{run_id}")
        jobs = _api(f"repos/{owner}/{repo}/actions/runs/{run_id}/jobs")
        return {"id": r["id"], "name": r.get("name"), "status": r["status"],
                "conclusion": r.get("conclusion"), "branch": r.get("head_branch"),
                "html_url": r["html_url"],
                "jobs": [{"id": j["id"], "name": j["name"], "status": j["status"],
                          "conclusion": j.get("conclusion")} for j in jobs.get("jobs", [])]}
    except Exception as exc:
        return _err(exc)


def github_run_workflow(owner: str, repo: str, workflow_id: str, ref: str, inputs: str = "{}") -> Dict[str, Any]:
    """Trigger a workflow_dispatch run. workflow_id is the file name (e.g. ci.yml) or numeric id."""
    blocked = _require_write("run_workflow")
    if blocked:
        return blocked
    try:
        parsed_inputs = json.loads(inputs) if inputs else {}
        body: Dict[str, Any] = {"ref": ref}
        if parsed_inputs:
            body["inputs"] = parsed_inputs
        _api(f"repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
             method="POST", body=body)
        return {"ok": True, "workflow": workflow_id, "ref": ref, "inputs": parsed_inputs}
    except Exception as exc:
        return _err(exc)


def github_get_job_logs(owner: str, repo: str, job_id: str) -> Dict[str, Any]:
    """Fetch the logs for a single Actions job (truncated to the tail)."""
    try:
        logs = _api(f"repos/{owner}/{repo}/actions/jobs/{job_id}/logs", raw=True)
        # Return the tail — failures are usually at the end.
        return {"job_id": job_id, "logs_tail": logs[-_MAX_TEXT:] if logs else ""}
    except Exception as exc:
        return _err(exc)


# ──────────────────────── Registration ─────────────────────

GITHUB_TOOLS: Dict[str, Any] = {
    "github_get_me": github_get_me,
    # repositories
    "github_get_file_contents": github_get_file_contents,
    "github_create_or_update_file": github_create_or_update_file,
    "github_delete_file": github_delete_file,
    "github_push_files": github_push_files,
    "github_create_branch": github_create_branch,
    "github_list_branches": github_list_branches,
    "github_list_commits": github_list_commits,
    "github_get_commit": github_get_commit,
    "github_create_repository": github_create_repository,
    "github_get_latest_release": github_get_latest_release,
    "github_list_releases": github_list_releases,
    # search
    "github_search_code": github_search_code,
    "github_search_repositories": github_search_repositories,
    "github_search_issues": github_search_issues,
    # issues
    "github_list_issues": github_list_issues,
    "github_get_issue": github_get_issue,
    "github_create_issue": github_create_issue,
    "github_update_issue": github_update_issue,
    "github_add_issue_comment": github_add_issue_comment,
    # pull requests
    "github_list_pull_requests": github_list_pull_requests,
    "github_get_pull_request": github_get_pull_request,
    "github_create_pull_request": github_create_pull_request,
    "github_update_pull_request": github_update_pull_request,
    "github_merge_pull_request": github_merge_pull_request,
    "github_create_pull_request_review": github_create_pull_request_review,
    # actions
    "github_list_workflows": github_list_workflows,
    "github_list_workflow_runs": github_list_workflow_runs,
    "github_get_workflow_run": github_get_workflow_run,
    "github_run_workflow": github_run_workflow,
    "github_get_job_logs": github_get_job_logs,
}

# Param names that should be typed as integers in the generated MCP schema.
INT_PARAMS = {"issue_number", "pull_number", "run_id", "job_id", "perPage"}


def register(registry: Dict[str, Any]) -> List[str]:
    """Merge the GitHub tools into an existing MCP TOOLS_REGISTRY. Returns names added."""
    registry.update(GITHUB_TOOLS)
    return list(GITHUB_TOOLS.keys())
