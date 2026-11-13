import { useBrand } from '@/brand/BrandProvider';

/** رقم المطوّر الاحتياطي: يبقى متاحًا حتى لو أُفرغ حقل developer.phone في brand.json. */
export const FALLBACK_DEVELOPER_PHONE = '01014868778';

/** يحوّل رقمًا محليًا (01014868778) إلى صيغة دولية بلا + (201014868778) كما يتطلب wa.me. */
export function toIntl(phone: string, countryCode = '20'): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith(countryCode) && digits.length >= 11) return digits;
  return countryCode + digits.replace(/^0+/, '');
}

export const whatsappLink = (phone: string, text?: string) =>
  `https://wa.me/${toIntl(phone)}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
export const telLink = (phone: string) => `tel:+${toIntl(phone)}`;

export function useDeveloperContact() {
  const brand = useBrand();
  const phone = brand.developer.phone?.trim() || FALLBACK_DEVELOPER_PHONE;
  return {
    phone,
    name: brand.developer.name,
    appName: brand.appName,
    tel: telLink(phone),
    wa: (text?: string) => whatsappLink(phone, text),
  };
}
