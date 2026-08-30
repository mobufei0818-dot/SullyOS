import React from 'react';
import { isImageValue } from '../../utils/blobRef';
import TokenImg from '../os/TokenImg';

/**
 * 银行资产图标的值是「一张图」还是「一段直接显示的文字（emoji）」。
 * 判断本身收口在 utils/blobRef 的 isImageValue（认 blobref 令牌 / data: / http(s) / 站内路径），
 * 这里只保留名字，方便 BankDollhouse 等调用方照旧引用。
 */
export const isBankAssetUrl = (value?: string | null): value is string => isImageValue(value);

interface BankAssetIconProps {
    value?: string | null;
    alt?: string;
    imgClassName: string;
    textClassName: string;
}

const BankAssetIcon: React.FC<BankAssetIconProps> = ({
    value,
    alt = '',
    imgClassName,
    textClassName,
}) => {
    if (!value) return null;

    if (isBankAssetUrl(value)) {
        return <TokenImg value={value} alt={alt} className={imgClassName} draggable={false} />;
    }

    return <span className={textClassName}>{value}</span>;
};

export default BankAssetIcon;
