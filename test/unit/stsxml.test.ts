import { describe, expect, it } from "vitest";
import { parseStsResponse } from "../../src/sts-xml";

const success = `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <Audience>awsbridge</Audience>
    <AssumedRoleUser>
      <Arn>arn:aws:sts::123456789012:assumed-role/awsbridge-poc/gw-u@example.com</Arn>
      <AssumedRoleId>AROAEXAMPLE:gw-u@example.com</AssumedRoleId>
    </AssumedRoleUser>
    <Credentials>
      <AccessKeyId>ASIAEXAMPLE</AccessKeyId>
      <SecretAccessKey>secret</SecretAccessKey>
      <SessionToken>token</SessionToken>
      <Expiration>2026-11-05T10:00:00Z</Expiration>
    </Credentials>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`;

const error = `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <Error>
    <Type>Sender</Type>
    <Code>InvalidIdentityToken</Code>
    <Message>Couldn't retrieve verification key from your identity provider.</Message>
  </Error>
  <RequestId>abc</RequestId>
</ErrorResponse>`;

describe("parseStsResponse", () => {
  it("成功 XML", () => {
    const r = parseStsResponse(success);
    expect(r).toEqual({
      ok: true,
      assumedRoleArn: "arn:aws:sts::123456789012:assumed-role/awsbridge-poc/gw-u@example.com",
      hasCredentials: true,
    });
  });
  it("エラー XML", () => {
    expect(parseStsResponse(error)).toEqual({
      ok: false,
      code: "InvalidIdentityToken",
      message: "Couldn't retrieve verification key from your identity provider.",
    });
  });
  it("解釈できない本文は ok:false", () => {
    const r = parseStsResponse("<html>boom</html>");
    expect(r.ok).toBe(false);
  });
});
