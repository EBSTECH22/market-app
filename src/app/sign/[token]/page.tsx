"use client";

import { useParams } from "next/navigation";
import ContractPacketView from "@/components/ContractPacketView";

// Emailed signing link — the token is the vendor's authorization, no login needed
export default function SignByToken() {
  const params = useParams<{ token: string }>();
  return <ContractPacketView apiPath={`/api/sign/${params.token}`} />;
}
