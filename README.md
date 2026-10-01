<small>This is a fork of Contributor. </small>
# How to self host this site

This guide walks you through forking this repository and deploying it as a live site using GitHub Pages, for free, with no server required.

---

## Prerequisites

- A GitHub account ([github.com/signup](https://github.com/signup))
- A web browser (no local software required)

---

## Step 1: Fork the Repository

1. Open this repository in your browser.
2. Click the **Fork** button in the top-right corner of the page.
3. Under "Owner", select your GitHub username.
4. Give it a name. Keep it short and lowercase with no spaces  this will appear in your site URL (e.g., `games` becomes `yourusername.github.io/games`).
5. Note that using names like `games` may get auto blocked by securly or network filtering.
6. Leave "Copy the main branch only" checked.
7. Click **Create fork**.

GitHub will copy the entire repository into your account. You now own an independent copy.

---

## Step 2:  Enable GitHub Pages

1. In your forked repository, go to **Settings** (the tab along the top).
2. In the left sidebar, click **Pages** under the "Code and automation" section.
3. Under "Source", select **Deploy from a branch**.
4. Under "Branch", choose **main** (or `master` if this repo uses that) from the dropdown, and set the folder to **/ (root)**.
5. Click **Save**.

GitHub will begin building your site. This usually takes 30 to 90 seconds.

---

## Step 3: Access Your Live Site

After saving, refresh the Pages settings page. A banner will appear at the top with your site URL in the format:

```
https://yourusername.github.io/repository-name
```

Click the link to confirm the site is live. If you see a 404, wait another minute and refresh, the first deploy can take a little longer.

---

## Step 4: Keep Your Fork Updated

This repository may receive new games or fixes over time. To pull those changes into your fork:

**Via the GitHub website:**

1. Go to your forked repository.
2. If your fork is behind the original, a notice will appear above the file list saying "This branch is X commits behind."
3. Click **Sync fork**, then **Update branch**.

**Via the command line:**

```bash
# Add the original repo as a remote (one-time setup)
git remote add upstream https://github.com/originalowner/repository-name.git

# Fetch and merge updates
git fetch upstream
git merge upstream/main
git push origin main
```

---

## Notes on Repository Visibility

By default, GitHub Pages on a free account requires the repository to be **public** in order to publish a site. If you set the repository to private, Pages will be disabled unless you are on a GitHub Pro or Team plan.

If you prefer the source code to remain private, consider Cloudflare Pages or Netlify, both of which support private repositories on their free tiers.
