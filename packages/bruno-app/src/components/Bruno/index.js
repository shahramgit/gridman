import React from 'react';
import gridmanNormalLogo from 'assets/gridman-normal.png';
import gridmanWireLogo from 'assets/gridman-wire.png';
import gridman3dLogo from 'assets/gridman-3d.png';

const logos = {
  'normal': gridmanNormalLogo,
  'wire': gridmanWireLogo,
  '3d': gridman3dLogo
};

const Bruno = ({ width, variant = 'normal' }) => {
  const logo = logos[variant] || logos.normal;

  return (
    <img
      src={logo}
      width={width}
      height={width}
      alt="Gridman"
      style={{ display: 'block', borderRadius: '20%' }}
    />
  );
};

export default Bruno;
