# Release process

Publishing uses the npm trusted publisher for `.github/workflows/publish.yml`. The workflow does not
use an npm token.

Before the first release, verify the trusted publisher in the npm package settings. It must use the
GitHub repository `huskly/ibkr-client` and the workflow filename `publish.yml`.

1. Update `version` in `package.json` to a stable semantic version.
2. Run `yarn install --immutable`, `yarn check`, and `yarn test`.
3. Commit and push the version change to `master`.
4. Create a draft GitHub Release. Use a tag that matches `v<version>`, for example `v2.4.1`, and
   target the current `master` commit.
5. Verify the draft, then publish the GitHub Release.

Publishing the GitHub Release starts npm publication immediately. The workflow rejects prereleases,
tag and package version mismatches, and tags that do not point to the current `master` commit. It
then installs the locked
dependencies, runs all project checks and tests, builds the package, and publishes it to npm with
provenance. A failed step prevents publication.
