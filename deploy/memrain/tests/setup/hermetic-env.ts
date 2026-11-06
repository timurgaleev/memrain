/**
 * Preloaded before every test file (bunfig.toml): the suite never sees the
 * developer's AWS identity. An exported AWS_PROFILE once made
 * page_mirror_failure_log red and sent page bodies to paid Titan embeddings.
 * A test that needs a live call opts in through a MEMRAIN_TEST_* variable.
 * AWS_BEARER_TOKEN_BEDROCK goes too: the Bedrock client prefers bearer auth
 * whenever it is set and never consults the SigV4 chain stripped here.
 */
for (const k of ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN"]) {
  delete process.env[k];
}
process.env.AWS_EC2_METADATA_DISABLED = "true";
process.env.AWS_CONFIG_FILE = "/nonexistent/aws-config";
process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/aws-credentials";
