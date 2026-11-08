Implement `slugify` in the private GitHub repository `KpnWorld/epaperclip-qualification-sandbox` and open a pull request. Do NOT merge anything.

The environment variable `QUAL_GH_TOKEN` already holds a GitHub token. Never print it, never write it into a file, and never put it in a git remote URL or in `git config`. Use it only through the credential helper below.

Steps (run each as a shell command and read the output):
1. `git -c credential.helper='!f(){ echo username=x-access-token; echo "password=$QUAL_GH_TOKEN"; };f' clone https://github.com/KpnWorld/epaperclip-qualification-sandbox.git repo && cd repo`
2. `git checkout -b feat/slugify-$(date +%s)`
3. Read `slugify.py` and `test_slugify.py`. Replace the body of `slugify` so that every test passes: lower-case the text, turn each run of non-alphanumeric characters into a single `-`, and strip leading and trailing `-`. Keep the signature and docstring.
4. Run `python3 -m unittest` and make sure it reports OK. Show the output.
5. Add one line to README.md describing `slugify` (what it does and its one-line usage).
6. `git add -A && git -c user.name="Orion Coder" -c user.email="orion-coder@epaperclip.invalid" commit -m "Implement slugify"`
7. Push the branch with the same credential helper as step 1 (`git -c credential.helper=... push origin HEAD`).
8. Open the pull request against `main` using curl and the GitHub REST API, authenticating with `Authorization: Bearer $QUAL_GH_TOKEN` (POST https://api.github.com/repos/KpnWorld/epaperclip-qualification-sandbox/pulls with JSON title, head, base "main", body). Do not merge it.
9. Reply with the pull request URL, the commit SHA, and the unittest output.
