import { useEffect } from "react";

import { parseClientInvite } from "../../connection/clientEnroll";

export const forkClientInviteAddress = (value: string | undefined) =>
  value && parseClientInvite(value) ? value : null;

/** An invite link only fills Address. The owner must still tap Add environment to redeem it. */
export function useForkClientInvite(
  value: string | undefined,
  setAddress: (value: string) => void,
) {
  useEffect(() => {
    const address = forkClientInviteAddress(value);
    if (address) setAddress(address);
  }, [value, setAddress]);
}
