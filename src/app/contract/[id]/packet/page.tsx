"use client";

import { useParams } from "next/navigation";
import ContractPacketView from "@/components/ContractPacketView";

export default function ContractPacket() {
  const params = useParams<{ id: string }>();
  return <ContractPacketView apiPath={`/api/contract/${params.id}`} />;
}
