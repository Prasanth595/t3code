import type { SecretProviderKind } from "@t3tools/contracts";
import type { SVGProps } from "react";

import { OnePasswordIcon } from "../Icons";

export function SecretProviderKindIcon({
  kind,
  ...props
}: SVGProps<SVGSVGElement> & { readonly kind: SecretProviderKind }) {
  switch (kind) {
    case "1password":
      return <OnePasswordIcon {...props} />;
  }
}
