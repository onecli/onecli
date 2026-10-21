// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HostWithDomain } from "./host-with-domain";

/** The domain is highlighted only on a label boundary, so a look-alike
 * host never reads as owned by the domain it merely ends with. */
const markOf = (host: string, domain: string | null) =>
  render(
    <HostWithDomain host={host} domain={domain} />,
  ).container.querySelector("mark");

describe("HostWithDomain", () => {
  it("highlights the domain at the end of a subdomain", () => {
    const { container } = render(
      <HostWithDomain host="api.stripe.com" domain="stripe.com" />,
    );
    expect(container.querySelector("mark")?.textContent).toBe("stripe.com");
    expect(container.textContent).toBe("api.stripe.com");
  });

  it("highlights a host equal to the domain", () => {
    expect(markOf("stripe.com", "stripe.com")?.textContent).toBe("stripe.com");
  });

  it.each([
    ["notstripe.com", "stripe.com"],
    ["stripe.com.evil.io", "stripe.com"],
    ["api.stripe.com", null],
  ])("does not highlight %s for %s", (host, domain) => {
    const { container } = render(
      <HostWithDomain host={host} domain={domain} />,
    );
    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toBe(host);
  });
});
