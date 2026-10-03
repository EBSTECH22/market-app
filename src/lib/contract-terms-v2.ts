// Lightfoot Roofs — Contract Terms v2 (effective on deploy) + versioning registry
// v1 contracts (signed before this deploy) keep rendering the original
// contract-clauses.ts language forever. New contracts are stamped v2 at
// creation, and the exact clause text is snapshotted onto the contract at
// signing so future edits can never change a signed document.

import { getContractClauses as getContractClausesV1, type ContractClause } from "@/lib/contract-clauses";

export type { ContractClause };

export const CURRENT_TERMS_VERSION = 2;

export const COMPANY = {
  name: "Lightfoot Roofing Inc, DBA Lightfoot Roofs",
  tradeName: "Lightfoot Roofs",
  cibRegistration: "OK 80006087",
  address: "2236 NW 164th St, Suite 12, Edmond, OK 73013",
};

// ── Plain-English summary shown above the terms (v2 only) ──
export const PLAIN_SUMMARY_TITLE = "HOW YOU PAY FOR THIS WORK — PLEASE READ";
export const PLAIN_SUMMARY: string[] = [
  "Your insurance company decides how much your roof repair is worth. We agree to do the work for whatever your insurance company approves for the work we perform, plus your deductible. The final price is not known today.",
  "Insurance estimates are often missing items — not enough squares, no ice and water shield, missing code items. When we find something missing, we send your insurance company documentation of what the job actually requires. If they approve more money for our work, that amount is added to what you owe us, and we will send you an itemized notice showing what was added and why. This can happen before, during, or after your roof is finished.",
  "Your insurance company sends those approval letters to you, not to us. Please forward us anything they send you about this claim within 5 days so we can keep your invoice accurate.",
  "You keep complete control of your insurance claim. We have no rights in your claim, your policy, or your insurance payments, and we are not taking any. Your insurance company pays you. You pay us on the dates in this contract.",
  "Your balance is due within 10 days of your completion invoice. If it is not paid by then, the unpaid balance accrues a late charge from the invoice date at the highest rate Oklahoma law allows (10% per year), plus collection costs.",
  "We cannot and will not pay any part of your deductible. Oklahoma law prohibits it.",
  "This written contract is the whole agreement. If anything was said in person, by text, or by email that isn't written here, it is not part of the deal. If you want something added or changed, we will put it in writing and we will both sign it.",
];

// ── Owner acknowledgment (initials) ──
export const OWNER_ACK_TEXT =
  "I understand the final Contract Price is not known today, that it will be set by what my insurance company approves for the work Lightfoot Roofs performs plus my deductible, and that approved supplements — including ones approved after my roof is finished — are added to what I owe.";

// ── FTC Cooling-Off Rule (16 CFR 429) ──
export const FTC_SIGNATURE_STATEMENT =
  "You, the buyer, may cancel this transaction at any time prior to midnight of the third business day after the date of this transaction. See the attached notice of cancellation form for an explanation of this right.";

// ── Oklahoma 59 O.S. § 1151.21 (claim-denial cancellation) ──
export const OK_CLAIM_DENIAL_STATEMENT =
  "You may cancel this contract at any time within seventy-two (72) hours after you have received written notification from your insurer that your claim to pay for the goods and services to be provided under this contract has been denied. See attached Notice of Cancellation for an explanation of this right.";

export function okClaimDenialFormText(): string {
  return `If your insurer denies all or any part of your claim to pay for goods and services to be provided under this contract, you may cancel the contract by mailing or delivering a signed and dated copy of this cancellation notice or any other written notice to ${COMPANY.name} at ${COMPANY.address} at any time within seventy-two (72) hours after you have received written notice that your claim has been denied. If you cancel, any payments made by you under the contract will be returned to you within ten (10) business days following receipt by the contractor of your cancellation notice.`;
}

export function ftcNoticeFormText(cancelDeadline: string): string {
  return `You may CANCEL this transaction, without any Penalty or Obligation, within THREE BUSINESS DAYS from the above date.

If you cancel, any property traded in, any payments made by you under the contract or sale, and any negotiable instrument executed by you will be returned within TEN BUSINESS DAYS following receipt by the seller of your cancellation notice, and any security interest arising out of the transaction will be cancelled.

If you cancel, you must make available to the seller at your residence, in substantially as good condition as when received, any goods delivered to you under this contract or sale, or you may, if you wish, comply with the instructions of the seller regarding the return shipment of the goods at the seller's expense and risk.

If you do make the goods available to the seller and the seller does not pick them up within 20 days of the date of your Notice of Cancellation, you may retain or dispose of the goods without any further obligation. If you fail to make the goods available to the seller, or if you agree to return the goods to the seller and fail to do so, then you remain liable for performance of all obligations under the contract.

To cancel this transaction, mail or deliver a signed and dated copy of this Cancellation Notice or any other written notice, or send a telegram, to ${COMPANY.name}, at ${COMPANY.address} NOT LATER THAN MIDNIGHT OF ${cancelDeadline}.`;
}

// ── 59 O.S. § 1151.30 notice — required WITH every initial estimate ──
export const ESTIMATE_DEDUCTIBLE_NOTICE_TITLE = "NOTICE REQUIRED BY OKLAHOMA LAW (59 O.S. § 1151.30)";
export const ESTIMATE_DEDUCTIBLE_NOTICE =
  "A residential or commercial roofing contractor providing repairs or improvement services to be paid by an insured from the proceeds of a property or casualty insurance policy shall not, as an inducement to the sale or provision of goods or services to an insured, advertise or promise to pay, directly or indirectly, all or part of any applicable insurance deductible or offer to compensate an insured for providing any service to the insured. If a roofing contractor violates this provision, the insurer to whom the insured tendered the claim shall not be obligated to consider the estimate prepared by the roofing contractor. Lightfoot Roofing Inc, DBA Lightfoot Roofs, does not and will not pay, waive, or absorb any portion of your deductible.";

// ── Business-day math for the FTC deadline (excludes Sundays + federal holidays) ──
const FIXED_HOLIDAYS_MMDD = ["01-01", "06-19", "07-04", "11-11", "12-25"];
function isBusinessDay(d: Date): boolean {
  if (d.getDay() === 0) return false; // Sunday
  const mmdd = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return !FIXED_HOLIDAYS_MMDD.includes(mmdd);
}
export function thirdBusinessDayAfter(start: Date): Date {
  const d = new Date(start);
  let added = 0;
  while (added < 3) {
    d.setDate(d.getDate() + 1);
    if (isBusinessDay(d)) added++;
  }
  return d;
}

// ── v2 clause set ──
export function getContractClausesV2(params: {
  shingleProduct: string;
  shingleColor: string;
  accessoryColor: string;
  deductible?: string | null;
}): ContractClause[] {
  const { shingleProduct, shingleColor, accessoryColor, deductible } = params;
  const deductibleDisplay = deductible
    ? ` ($${parseFloat(deductible).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`
    : "";

  return [
    {
      number: 1,
      title: "SCOPE OF WORK",
      body: `Contractor agrees to perform all roofing and related work described in this contract in a professional and workmanlike manner, in strict accordance with applicable local building codes, manufacturer installation specifications, and accepted industry standards. All work shall be performed at the property address stated herein. The Standard Roof Replacement Scope listed above is incorporated into and made part of this contract.`,
    },
    {
      number: 2,
      title: "MATERIALS",
      body: `All materials used shall be new, of good commercial quality, and appropriate for the specified application. Shingle product (${shingleProduct}), color (${shingleColor}), and accessory paint color (${accessoryColor}) have been agreed upon as specified. Contractor reserves the right to substitute materials of equal or greater quality if specified materials become unavailable, subject to prior written approval from Owner.`,
    },
    {
      number: 3,
      title: "CONTRACT PRICE",
      body: `3.1 Definitions. "Insurance Scope" means the line items in Owner's insurance carrier's written estimate, and every revision, correction, or supplement to it, covering work Contractor is obligated to perform under this contract. "Approved Amount" means the total sum the carrier approves for the Insurance Scope, including replacement cost value, overhead and profit, code and ordinance upgrade coverage, recoverable and non-recoverable depreciation, and every supplemental or additional amount approved at any time, whether before, during, or after completion of the work. 3.2 The Contract Price is the Approved Amount, plus Owner's deductible, plus any amount for additional work authorized by signed change order under Clause 10. 3.3 Owner acknowledges and agrees that the Contract Price is not a fixed sum known on the date this contract is signed. It is determined by the carrier's written approvals for the Insurance Scope. Owner agrees to pay the Contract Price as finally determined. The parties agree that the Approved Amount, determined by the carrier's independent written evaluation of the work, represents the reasonable value of the work performed within the meaning of 15 O.S. Section 112.`,
    },
    {
      number: 4,
      title: "PAYMENT TERMS",
      body: `4.1 Prior to commencement of work, Owner shall pay Contractor the greater of (a) the actual cash value amount the carrier has approved for the Insurance Scope, or (b) fifty percent (50%) of the Contract Price then known. 4.2 The balance of the Contract Price known as of substantial completion, including Owner's deductible, is due within ten (10) days of the date of Contractor's invoice for the completed work. 4.3 Each amount added to the Contract Price by a supplemental approval under Clause 5 is due within ten (10) days of the notice described in Clause 5.4, or within ten (10) days of the completion invoice, whichever is later. 4.4 Owner's obligation to pay the Contract Price is Owner's own direct obligation. Payment is due on the dates stated above regardless of whether, when, or in what amount Owner receives any payment from any insurance carrier. Payment is not conditioned on Owner's receipt of insurance proceeds. 4.5 Contractor claims no right, title, or interest in any insurance policy, claim, benefit, or payment. Owner alone owns and controls the claim and any proceeds of it.`,
    },
    {
      number: 5,
      title: "SUPPLEMENTAL APPROVALS",
      body: `5.1 Owner acknowledges that insurance carrier estimates are frequently incomplete or understated, and that additional materials, quantities, labor, or line items required by manufacturer installation specifications, applicable building codes, or actual field conditions are commonly identified after this contract is signed and after work has begun or been completed. Examples include but are not limited to: shortfalls in measured squares or waste factor; ice and water shield; drip edge; starter course; ridge and off-ridge ventilation; decking, deck repair, and re-nailing; flashing, pipe boots, and counterflashing; underlayment upgrades; steep and high charges; disposal; and code-required upgrades. 5.2 Contractor may prepare and submit to the carrier documentation of the materials, quantities, and labor actually required to complete the Insurance Scope in accordance with manufacturer specifications and applicable code. 5.3 The Contract Price automatically increases by any additional amount the carrier approves for the Insurance Scope, without the need for a new agreement, addendum, or additional signature, whether that approval occurs before work begins, during the work, or at any time after the work is completed, and whether or not the additional item was identified or anticipated when this contract was signed. 5.4 Owner acknowledges that the carrier issues supplemental approvals, revised estimates, and explanations of benefits directly to Owner, and that Contractor does not receive them from the carrier. Owner shall deliver a legible copy of each such document to Contractor within five (5) days of Owner's receipt. Contractor will deliver to Owner written notice of the resulting adjustment within ten (10) days after Contractor first receives or otherwise obtains documentation of a supplemental approval, whether from Owner or from any other source. The notice will identify each added line item and its approved amount and state the revised Contract Price. Notice by email to the address Owner provides is sufficient. 5.5 If Owner believes a supplemental line item covers work Contractor did not and will not perform, Owner may object in writing within five (5) business days of the notice in Clause 5.4, stating which item and why. Contractor will remove any item Owner establishes was not performed. Items not objected to within that period are due and payable as part of the Contract Price. 5.6 Amounts the carrier approves for scope Contractor does not perform are not part of the Contract Price and belong to Owner. 5.7 Owner's failure to deliver documentation under Clause 5.4 does not waive, reduce, or delay the adjustment to the Contract Price under Clause 5.3. Where Contractor obtains documentation of a supplemental approval from a source other than Owner, the notice in Clause 5.4 and the objection period in Clause 5.5 apply in the same manner. Where Owner has not delivered documentation Owner received, Contractor may invoice based on the carrier documentation available to it. 5.8 Recoverable depreciation approved for the Insurance Scope is part of the Contract Price and is due under Clause 4 on completion of the work, whether or not the carrier has released it to Owner by that date. Owner agrees to promptly sign and submit any completion documentation the carrier requires to obtain its release.`,
    },
    {
      number: 6,
      title: "DEDUCTIBLE",
      body: `Owner's insurance deductible${deductibleDisplay} is owed by Owner and is part of the Contract Price. Consistent with 59 O.S. Section 1151.30, Contractor will not pay, waive, rebate, absorb, discount, or offset any portion of Owner's deductible, directly or indirectly, and has made no promise or representation to do so.`,
    },
    {
      number: 7,
      title: "NO ASSIGNMENT OF INSURANCE BENEFITS",
      body: `Nothing in this contract constitutes, and neither party intends, an assignment, transfer, pledge, or conveyance of any post-loss insurance benefit, claim, right of action, or policy right, in whole or in part. Owner retains sole ownership and control of the insurance claim. If any provision of this contract is construed to be such an assignment, that provision shall be severed and the remainder of this contract shall remain in full force and effect.`,
    },
    {
      number: 8,
      title: "CONTRACTOR REGISTRATION, INSURANCE, AND ROLE",
      body: `8.1 Registration. Contractor is a roofing contractor registered with the Oklahoma Construction Industries Board, Registration No. ${COMPANY.cibRegistration}, with a Residential Roofing Endorsement. 8.2 Workers' compensation. All individuals performing work under this contract are covered by workers' compensation insurance, as required by 59 O.S. Section 1151.22. Contractor maintains commercial general liability insurance of not less than $500,000 as required for residential roofing registration. 8.3 Not a public adjuster. Contractor is not a public adjuster, does not represent Owner in the adjustment or negotiation of Owner's insurance claim, and charges no fee for claim-related services. Documentation Contractor provides to the carrier describes the scope, materials, and labor required to perform the work under this contract. All decisions regarding the claim remain Owner's.`,
    },
    {
      number: 9,
      title: "PROJECT DOCUMENTS",
      body: `So that the Contract Price can be determined and invoiced accurately, Owner agrees to provide Contractor with copies of every document the carrier issues relating to the Insurance Scope — including estimates, revised estimates, supplemental approvals, explanations of benefits, and payment summaries — within five (5) days of Owner's receipt. Owner acknowledges the carrier sends these documents to Owner and not to Contractor, and that Contractor depends on Owner to forward them. This is a document-sharing obligation only. Owner remains free to make any decision regarding the claim, including settling or resolving it, without Contractor's consent or involvement, and the Contract Price remains payable under Clause 4 regardless of how Owner resolves the claim.`,
    },
    {
      number: 10,
      title: "CHANGES TO SCOPE",
      body: `Any work outside the Insurance Scope must be authorized by a written change order signed by Owner before that work is performed. Clause 5 governs additional amounts within the Insurance Scope and does not require a separate change order.`,
    },
    {
      number: 11,
      title: "LIMITED WARRANTY",
      body: `For all GAF roofing systems installed under this contract, Lightfoot Roofs provides the GAF Systems Plus Warranty covering both materials and workmanship. For all other materials, manufacturer warranties are passed through in full. Contractor separately provides this LIMITED WARRANTY: Contractor warrants all labor and workmanship for five (5) years from substantial project completion. Warranty claims must be submitted in writing within the warranty period. This limited warranty is in addition to, and does not waive, limit, or disclaim, any implied warranty of habitability or of good and workmanlike performance or any other right Owner has under Oklahoma law.`,
    },
    {
      number: 12,
      title: "LATE PAYMENT AND COLLECTION",
      body: `If the Contract Price is not paid in full within ten (10) days of the date of the completion invoice, the entire unpaid balance shall immediately begin to bear a service charge, accruing from the date of the completion invoice, at the lesser of ten percent (10%) per annum (0.83% per month) or the maximum rate permitted by Oklahoma law, until paid in full. Supplemental amounts invoiced after completion bear the same charge if unpaid ten (10) days after their invoice date, accruing from that invoice date. If Contractor prevails in an action to collect amounts owed under this contract, Owner shall pay Contractor's reasonable attorney fees and costs, as provided by 12 O.S. Section 936. Contractor reserves all lien rights available under Oklahoma law for labor and materials furnished.`,
    },
    {
      number: 13,
      title: "OWNER'S RIGHTS TO CANCEL",
      body: `13.1 Three-business-day right (sales away from Contractor's place of business). If this contract was signed at Owner's residence or at any location other than Contractor's place of business, Owner may cancel this transaction at any time prior to midnight of the third business day after the date of this transaction, as described in the Notice of Cancellation furnished with this contract. Business days exclude Sundays and federal holidays. 13.2 Seventy-two-hour right on claim denial (59 O.S. Section 1151.21). Owner may cancel this contract at any time within seventy-two (72) hours after Owner receives written notification from Owner's insurer that Owner's claim to pay for the goods and services to be provided under this contract has been denied, in whole or in part, as described in the separate Notice of Cancellation (Claim Denial) furnished with this contract. If Owner cancels under this provision, Contractor will return any payments made by Owner within ten (10) business days of receiving the cancellation notice; Contractor is entitled to the reasonable value of any emergency services Owner acknowledged in writing were necessary to prevent damage to the property.`,
    },
    {
      number: 14,
      title: "GOVERNING LAW AND DISPUTE RESOLUTION",
      body: `This contract shall be governed by and construed in accordance with the laws of the State of Oklahoma. Both parties agree to make every reasonable effort to resolve any dispute, claim, or controversy arising out of or relating to this contract through good-faith negotiation and direct communication before pursuing any other remedy. If direct negotiation does not resolve the dispute within thirty (30) days of written notice, the parties agree to submit the matter to non-binding mediation with a mutually agreed-upon mediator prior to initiating any formal legal proceedings. Any legal action initiated as a last resort shall be brought in the state courts of Oklahoma County, Oklahoma; provided, however, that any action to foreclose or enforce a mechanic's or materialman's lien shall be brought in the district court of the county in which the property is located, as required by 12 O.S. Section 131, and, at Contractor's election, venue for any other dispute may instead be laid in the county in which the property is located. Both parties consent to jurisdiction in the venues described in this paragraph. Nothing in this contract restricts either party from enforcing its rights by the usual legal proceedings in the ordinary tribunals.`,
    },
    {
      number: 15,
      title: "ENTIRE AGREEMENT; NO ORAL OR INFORMAL MODIFICATION",
      body: `15.1 Entire agreement. This contract, together with any change order signed by both parties, is the complete and final agreement between the parties and is the sole and controlling statement of their obligations. It supersedes and replaces all prior and contemporaneous agreements, understandings, negotiations, proposals, estimates, quotes, brochures, advertisements, statements, and representations of any kind, whether written or oral. 15.2 No reliance. Owner acknowledges that Owner has not relied on any statement, promise, assurance, or representation that is not written in this contract, and that no such statement, promise, assurance, or representation has been made. 15.3 Modification only in a signed writing. This contract may be modified, amended, supplemented, or terminated only by a written instrument that identifies itself as an amendment or change order to this contract and is signed by Owner and by an authorized officer of Contractor. Without limitation, no text message, email, voicemail, telephone call, in-person or job-site conversation, social media or chat message, handwritten note, photograph, invoice, or course of dealing or performance modifies, amends, waives, or supersedes any term of this contract, regardless of its content and regardless of who sent or received it. 15.4 Authority. No sales representative, canvasser, estimator, project manager, crew member, subcontractor, or other employee or agent of Contractor has authority to modify this contract, waive any of its terms, or make any representation, promise, or commitment binding on Contractor. Only a written amendment signed by an authorized officer of Contractor is binding. 15.5 No waiver. Contractor's failure or delay in enforcing any provision of this contract is not a waiver of that provision or of any other provision, and does not waive Contractor's right to enforce it later. Acceptance of a partial or late payment is not a waiver of any amount owed. No waiver is effective unless in a writing signed by an authorized officer of Contractor, and a waiver on one occasion is not a continuing waiver. 15.6 Notices are not modifications. Notices, invoices, objections, and other documents this contract requires or permits — including Contractor's supplemental notice under Clause 5.4, Owner's objection under Clause 5.5, and Owner's delivery of carrier documents under Clause 9 — are effective according to their stated terms, including where this contract permits delivery by email. Giving or receiving such a notice does not modify this contract, and this Clause 15 does not limit or impair those notice provisions. 15.7 Cancellation rights preserved. Nothing in this Clause 15 limits, conditions, or waives Owner's rights to cancel under Clause 13, which Owner may exercise by any written notice as described in the applicable Notice of Cancellation. 15.8 Severability. If any provision of this contract is held invalid or unenforceable, that provision shall be severed and the remaining provisions shall remain in full force and effect.`,
    },
  ];
}

// ── Version registry ──
export function getClausesForVersion(
  version: number,
  params: { shingleProduct: string; shingleColor: string; accessoryColor: string; deductible?: string | null }
): ContractClause[] {
  if (version >= 2) return getContractClausesV2(params);
  return getContractClausesV1(params);
}

// ══════════════════════════════════════════════════════════════════════════
// RETAIL
//
// The clauses above are written for insurance work: the price is whatever the
// carrier approves, supplements adjust it automatically, and the deductible is
// part of it. None of that is true on a retail job, where the customer agreed
// to a number and that number is the price.
//
// The retail set is derived from the insurance set rather than copied, so
// clauses that are genuinely shared — scope, materials, warranty, governing
// law — can never drift between the two documents.
// ══════════════════════════════════════════════════════════════════════════

export const RETAIL_PLAIN_SUMMARY_TITLE = "HOW YOU PAY FOR THIS WORK — PLEASE READ";

export const RETAIL_PLAIN_SUMMARY: string[] = [
  "The price shown on this contract is the full price for the work described below. It is not an estimate, and it will not change on its own.",
  "If you decide you would like something different, or if we uncover something that has to be repaired before we can finish — damaged decking under your old shingles, for example — we will show you what we found and what it costs. Nothing is added until you have seen it and signed a change order.",
  "You will pay a deposit before we begin and the remaining balance once the work is complete — within 10 days of your completion invoice. Balances unpaid after that accrue a late charge from the invoice date at the highest rate Oklahoma law allows (10% per year). The amounts and due dates are in the payment terms below.",
  "This document is our complete agreement. If something was discussed in person, by text, or by email that is not written here, please tell us before you sign so we can add it.",
];

export const RETAIL_OWNER_ACK_TEXT =
  "I understand this is a fixed-price agreement, that the Contract Price shown above is the amount I have agreed to pay, and that it changes only by a change order I sign.";

/**
 * Retail clause set.
 *
 * Dropped entirely: supplemental approvals, deductible, and no-assignment —
 * all three exist only because a carrier is paying.
 * Rewritten: contract price, payment terms, and the cancellation clause, which
 * on a retail job carries the FTC three-day right but not the Oklahoma
 * claim-denial right, since there is no claim to deny.
 */
export function getContractClausesRetail(
  params: { shingleProduct: string; shingleColor: string; accessoryColor: string; contractPrice?: string | null }
): ContractClause[] {
  const base = getContractClausesV2({
    shingleProduct: params.shingleProduct,
    shingleColor: params.shingleColor,
    accessoryColor: params.accessoryColor,
    deductible: null,
  });

  const DROP = new Set([
    "SUPPLEMENTAL APPROVALS",
    "DEDUCTIBLE",
    "NO ASSIGNMENT OF INSURANCE BENEFITS",
    // Entirely about forwarding carrier estimates and EOBs.
    "PROJECT DOCUMENTS",
  ]);

  const priceDisplay = params.contractPrice ? ` of ${params.contractPrice}` : "";

  const REWRITE: Record<string, string> = {
    "CONTRACT PRICE":
      `#.1 The Contract Price${priceDisplay} is the total amount Owner agrees to pay Contractor for the work described in this contract. It is a fixed sum, agreed on the date this contract is signed. #.2 The Contract Price includes all labor, materials, equipment, permits, and disposal necessary to complete the scope of work, except for items expressly excluded in the scope. #.3 The Contract Price changes only by a written change order signed by both parties under the Changes to Scope clause. No estimate, insurance document, or verbal discussion adjusts it.`,

    "PAYMENT TERMS":
      `#.1 Prior to commencement of work, Owner shall pay Contractor a deposit in the amount stated on the face of this contract. #.2 The balance of the Contract Price is due within ten (10) days of the date of Contractor's invoice for the completed work. #.3 Any amount added by a signed change order is due within ten (10) days of Contractor's invoice for that work, or with the completion balance, whichever is later. #.4 Owner's obligation to pay the Contract Price is Owner's own direct obligation and is not conditioned on financing, sale of the property, or payment from any third party.`,

    "CONTRACTOR REGISTRATION, INSURANCE, AND ROLE":
      `#.1 Registration. Contractor is a roofing contractor registered with the Oklahoma Construction Industries Board, Registration No. ${COMPANY.cibRegistration}, with a Residential Roofing Endorsement. #.2 Workers' compensation. All individuals performing work under this contract are covered by workers' compensation insurance, as required by 59 O.S. Section 1151.22. Contractor maintains commercial general liability insurance of not less than $500,000 as required for residential roofing registration.`,

    "LATE PAYMENT AND COLLECTION":
      `Any amount not paid within ten (10) days of its due date bears a late charge from the date of the invoice, at the lesser of ten percent (10%) per annum (0.83% per month) or the maximum rate permitted by Oklahoma law, until paid in full. Amounts added by signed change order and invoiced after completion bear the same charge if unpaid ten (10) days after their invoice date. Owner shall pay Contractor's reasonable costs of collection, including reasonable attorney's fees, incurred in collecting any amount due under this contract. Contractor reserves and does not waive any lien right available under Oklahoma law.`,

    "CHANGES TO SCOPE":
      `Any work outside the scope of work described in this contract must be authorized by a written change order signed by Owner before that work is performed. The change order will describe the additional work and state the additional amount, and that amount is added to the Contract Price. Work not described in this contract or in a signed change order is outside the agreed scope.`,

    "OWNER'S RIGHTS TO CANCEL":
      `Three-business-day right (sales away from Contractor's place of business). If this contract was signed at Owner's residence or at any location other than Contractor's place of business, Owner may cancel this transaction at any time prior to midnight of the third business day after the date of this transaction, as described in the Notice of Cancellation furnished with this contract. Business days exclude Sundays and federal holidays.`,
  };

  // A few clauses are shared almost entirely but name insurance-only paragraphs
  // that no longer exist here. Patching the sentence beats maintaining a second
  // copy of a long clause that would drift out of sync.
  const PATCHES: [RegExp, string][] = [
    [
      /— including Contractor's supplemental notice under Clause [\d.]+, Owner's objection under Clause [\d.]+, and Owner's delivery of carrier documents under Clause \d+ —/g,
      "",
    ],
    [/\bthe Insurance Scope\b/g, "the scope of work"],
    [/\bInsurance Scope\b/g, "scope of work"],
  ];

  const kept = base.filter((c) => !DROP.has(c.title));

  // Renumbering has to carry the bodies with it. Clause text refers to its own
  // subsections ("15.3") and cross-references others ("under Clause 10"), so
  // shifting the numbers without rewriting those leaves a contract that cites
  // paragraphs which no longer exist.
  const remap = new Map<number, number>();
  kept.forEach((c, i) => remap.set(c.number, i + 1));

  return kept.map((c, i) => {
    const n = i + 1;
    let body = REWRITE[c.title] ?? c.body;

    // Rewritten bodies use "#" as a placeholder for their own clause number.
    body = body.split("#.").join(`${n}.`);

    if (!REWRITE[c.title]) {
      for (const [find, rep] of PATCHES) body = body.replace(find, rep);
      // Own subsection numbers: "15.3" -> "12.3".
      body = body.replace(
        new RegExp(`\\b${c.number}\\.(\\d)`, "g"),
        (_m, sub) => `${n}.${sub}`
      );
    }

    // Cross-references to other clauses.
    body = body.replace(/Clause (\d+)/g, (m, num) => {
      const mapped = remap.get(Number(num));
      return mapped ? `Clause ${mapped}` : m;
    });

    return { ...c, number: n, body };
  });
}

export type ContractJobType = "RETAIL" | "INSURANCE";

/** Clause set for a job type. */
export function getClausesForJob(
  version: number,
  jobType: ContractJobType,
  params: { shingleProduct: string; shingleColor: string; accessoryColor: string; deductible?: string | null; contractPrice?: string | null }
): ContractClause[] {
  if (jobType === "RETAIL") return getContractClausesRetail(params);
  return getClausesForVersion(version, params);
}

export function getPlainSummary(jobType: ContractJobType): { title: string; items: string[] } {
  return jobType === "RETAIL"
    ? { title: RETAIL_PLAIN_SUMMARY_TITLE, items: RETAIL_PLAIN_SUMMARY }
    : { title: PLAIN_SUMMARY_TITLE, items: PLAIN_SUMMARY };
}

export function getOwnerAckText(jobType: ContractJobType): string {
  return jobType === "RETAIL" ? RETAIL_OWNER_ACK_TEXT : OWNER_ACK_TEXT;
}

/**
 * Does the Oklahoma claim-denial cancellation notice apply?
 *
 * 59 O.S. § 1151.21 is triggered by goods and services "to be paid ... from the
 * proceeds of a property or casualty insurance policy". A retail job has no
 * claim, so attaching the notice would tell the customer they can cancel on a
 * denial that cannot occur.
 */
export function needsClaimDenialNotice(jobType: ContractJobType): boolean {
  return jobType === "INSURANCE";
}


// ── Estimate terms — same language the Service Agreement uses ──
export const ESTIMATE_TERMS_TITLE = "TERMS";
export const ESTIMATE_TERMS: string[] = [
  `Payment. Any deposit stated on this estimate is due before work begins. The remaining balance is due within ten (10) days of the date of Contractor's invoice for the completed work.`,
  `Late payment. Any amount not paid within ten (10) days of its due date bears a late charge from the date of the invoice, at the lesser of ten percent (10%) per annum (0.83% per month) or the maximum rate permitted by Oklahoma law, until paid in full, plus Contractor's reasonable costs of collection, including reasonable attorney's fees, as provided by 12 O.S. Section 936.`,
  `Registration and insurance. Contractor is a roofing contractor registered with the Oklahoma Construction Industries Board, Registration No. ${COMPANY.cibRegistration}, with a Residential Roofing Endorsement. All individuals performing work under the resulting contract are covered by workers' compensation insurance, as required by 59 O.S. Section 1151.22.`,
  `Agreement controls. Work is performed under ${COMPANY.name}'s written Service Agreement, signed before work begins. This estimate is not a contract. If this estimate and the signed Service Agreement differ, the Service Agreement controls.`,
];
