# XO's Fabric Chat on XO Launchpad: the one-container image plus this company's settings.
# Build the base first (see ../README.md), then deploy this folder with Liftoff.
FROM fabric-chat-solo:0.3.0-xologin
COPY company.json /company/company.json
COPY first-password /company/first-password
# "Sign in with XO": the xo server says where XO's sign-in is (see ../README.md).
ENV XO_LOGIN_SERVER=https://xo.quirq.dev
